/**
 * Singleton Playwright browser pool.
 *
 * One long-lived Chromium process is shared across all concurrent scrape
 * requests.  Per-request isolation is provided by browser contexts —
 * lightweight sandboxes with separate cookies, storage, and network state.
 *
 *   Chromium process
 *       ├── Context 1 → Anthem scrape
 *       ├── Context 2 → Aetna scrape
 *       └── Context 3 → UHC scrape
 *
 * Concurrency is governed by a semaphore:
 *   - At most `config.playwrightMaxContexts` contexts may exist at once.
 *   - Additional requests wait in a bounded FIFO queue.
 *   - When the queue is also full, `BrowserPoolFullError` is thrown and
 *     the caller should return HTTP 503.
 *
 * Idle shutdown:
 *   - When the active count drops to zero and the queue is empty, a
 *     5-minute timer starts.  If no new requests arrive, the Chromium
 *     process is closed to reclaim ~200 MB of RAM.  The next request
 *     restarts it transparently.
 *
 * Graceful drain:
 *   - `browserPool.shutdown()` is called on SIGTERM / SIGINT.  It rejects
 *     all queued waiters immediately and closes the browser so no orphan
 *     Chromium processes remain after the Node.js process exits.
 */

import type { Browser, BrowserContext } from "playwright";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

// ── Public error class ────────────────────────────────────────────────────────

/**
 * Thrown when the pool's queue is full.
 * Callers (route handlers) should map this to HTTP 503.
 */
export class BrowserPoolFullError extends Error {
  constructor() {
    super("Too many concurrent scrape requests — try again shortly");
    this.name = "BrowserPoolFullError";
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** How long the pool waits with no activity before closing Chromium. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Browser context defaults shared by all scrape requests. */
const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ignoreHTTPSErrors: false,
  // Service workers register their own fetch handler and bypass
  // page.route() interception — that is a SSRF bypass path.
  serviceWorkers: "block" as const,
};

// ── Pool implementation ───────────────────────────────────────────────────────

class BrowserPool {
  private browser: Browser | null = null;
  /** Non-null while a launch is in flight (coalesces concurrent callers). */
  private launching: Promise<Browser> | null = null;

  /** Number of contexts currently open (including those being created). */
  private active = 0;

  /**
   * Monotonically-increasing counter bumped on every unexpected browser crash.
   *
   * Each acquired context slot is tagged with the generation that was current
   * when `active` was incremented for it.  `release()` looks up the context's
   * generation via `contextGeneration` and only calls `returnSlot()` when the
   * generation still matches — orphaned contexts from a crashed generation are
   * silently discarded instead of decrementing `active` below zero.
   */
  private generation = 0;

  /**
   * Maps each live BrowserContext to the generation that owns its slot.
   *
   * Set when the context is created inside `acquire()`; deleted when
   * `release()` is called.  WeakMap so closed / GC-ed contexts don't leak.
   */
  private readonly contextGeneration = new WeakMap<BrowserContext, number>();

  /**
   * Waiters blocked on a full semaphore.
   * Each entry is { resolve, reject } for the Promise inside acquire().
   */
  private queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  // ── Idle timer ──────────────────────────────────────────────────────────────

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.closeBrowser("idle timeout");
    }, IDLE_TIMEOUT_MS);
  }

  private async closeBrowser(reason: string): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.launching = null;
    if (b) {
      logger.info({ reason }, "Browser pool: closing Chromium");
      try {
        await b.close();
      } catch (err) {
        logger.warn({ err, reason }, "Browser pool: error closing Chromium");
      }
    }
  }

  // ── Browser lifecycle ───────────────────────────────────────────────────────

  /**
   * Returns the running browser, launching it if necessary.
   * Concurrent callers during launch are coalesced onto the same Promise.
   */
  private getOrLaunchBrowser(): Promise<Browser> {
    // Return existing connected browser.
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);

    // Coalesce concurrent launch attempts onto a single in-flight Promise.
    if (this.launching) return this.launching;

    const isRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    const sandboxArgs = isRoot
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [];

    logger.info("Browser pool: launching Chromium");

    this.launching = import("playwright")
      .then(({ chromium }) =>
        chromium.launch({
          headless: true,
          args: [...sandboxArgs, "--disable-dev-shm-usage", "--disable-gpu"],
        }),
      )
      .then((b) => {
        this.browser = b;
        this.launching = null;
        logger.info("Browser pool: Chromium ready");

        // Detect unexpected disconnection (crash / OOM kill).
        b.on("disconnected", () => {
          if (this.browser === b) {
            logger.warn(
              { active: this.active, queued: this.queue.length },
              "Browser pool: Chromium disconnected unexpectedly — resetting pool",
            );
            this.browser = null;
            this.launching = null;
            this.cancelIdleTimer();

            // Bump the generation so that in-flight requests' finally-block
            // release() calls are recognised as orphans and discarded rather
            // than decrementing `active` below zero.
            this.generation++;
            this.active = 0;

            // Reject every queued waiter so callers don't hang indefinitely.
            const pending = this.queue.splice(0);
            const crashErr = new Error(
              "Browser pool: Chromium disconnected unexpectedly",
            );
            for (const { reject } of pending) {
              reject(crashErr);
            }
          }
        });

        return b;
      })
      .catch((err: unknown) => {
        this.launching = null;
        throw err;
      });

    return this.launching;
  }

  // ── Semaphore ───────────────────────────────────────────────────────────────

  /**
   * Acquire a new browser context for one scrape request.
   *
   * - If a slot is free → create context immediately.
   * - If the pool is full but queue has room → wait for a slot.
   * - If both are full → throw `BrowserPoolFullError` (caller → HTTP 503).
   *
   * Always call `release(context)` in a `finally` block.
   */
  async acquire(): Promise<BrowserContext> {
    if (this.shuttingDown) {
      throw new Error("Browser pool is shutting down");
    }

    this.cancelIdleTimer();

    const { playwrightMaxContexts: maxCtx, playwrightQueueLimit: maxQ } =
      config;

    if (this.active < maxCtx) {
      // ── Fast path: slot available immediately ──
      this.active++;
    } else if (this.queue.length < maxQ) {
      // ── Slow path: wait for a released slot ──
      logger.info(
        { active: this.active, queued: this.queue.length + 1, maxCtx },
        "Browser pool: at capacity, queuing request",
      );
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ resolve, reject });
      });
      // The releasing context already decremented `active` (see returnSlot).
      // Re-increment now that we officially own the slot.
      this.active++;
    } else {
      // ── Both full: reject ──
      logger.warn(
        { active: this.active, queued: this.queue.length, maxCtx, maxQ },
        "Browser pool: queue full, rejecting request",
      );
      throw new BrowserPoolFullError();
    }

    // Capture the generation AFTER active++ so we know which crash epoch owns
    // this slot.  This value is used both in the error path (to decide whether
    // to returnSlot) and stored on the context (to validate release() calls).
    const slotGeneration = this.generation;

    // Slot is held — create the context.
    // On any failure, release the slot so the pool does not leak.
    try {
      const browser = await this.getOrLaunchBrowser();
      const ctx = await browser.newContext(CONTEXT_OPTIONS);

      // If a crash occurred during the async operations above, the generation
      // has been bumped and `active` was reset to 0.  Our original active++
      // was wiped, so re-register this context under the current generation.
      if (this.generation !== slotGeneration) {
        this.active++;
      }

      this.contextGeneration.set(ctx, this.generation);
      logger.debug(
        { active: this.active, queued: this.queue.length },
        "Browser pool: context acquired",
      );
      return ctx;
    } catch (err) {
      // Only return the slot if no crash wiped it; otherwise active is already 0.
      if (this.generation === slotGeneration) {
        this.returnSlot();
      }
      throw err;
    }
  }

  /**
   * Release a context back to the pool.
   * Must be called in a `finally` block after every successful `acquire()`.
   */
  async release(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch (err) {
      logger.warn({ err }, "Browser pool: error closing context");
    }

    const ctxGen = this.contextGeneration.get(context);
    this.contextGeneration.delete(context);

    if (ctxGen === this.generation) {
      // Normal path: context belongs to the current generation.
      this.returnSlot();
    } else {
      // Orphan: context was created under a now-crashed browser generation.
      // The crash handler already reset active; do not decrement it again.
      logger.debug(
        { ctxGen, currentGeneration: this.generation },
        "Browser pool: discarding release from crashed generation",
      );
    }
  }

  /**
   * Internal: decrement active and hand the freed slot to the next queued
   * waiter (if any), or start the idle timer when all slots are free.
   *
   * Note: unlike the original "inheritance" approach, returnSlot always
   * decrements `active`.  Waiters re-increment it when they resume after
   * the queue promise resolves.  This ensures the crash handler's `active=0`
   * reset is never undone by a late returnSlot from a pre-crash context.
   */
  private returnSlot(): void {
    this.active--;
    logger.debug(
      { active: this.active },
      "Browser pool: context released",
    );

    const next = this.queue.shift();
    if (next) {
      // Signal the waiter — it will do its own active++ on resume.
      next.resolve();
    } else if (this.active === 0 && !this.shuttingDown) {
      this.scheduleIdleShutdown();
    }
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  /**
   * Shut the pool down cleanly.
   *
   * - Queued waiters receive an error immediately so their requests can
   *   return rather than hanging until SIGKILL.
   * - The Chromium process is closed so no orphans remain.
   *
   * Call this on SIGTERM / SIGINT.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cancelIdleTimer();

    // Reject all queued waiters so their acquire() calls settle immediately.
    const pending = this.queue.splice(0);
    const shutdownErr = new Error("Browser pool is shutting down");
    for (const { reject } of pending) {
      reject(shutdownErr);
    }

    await this.closeBrowser("graceful shutdown");
  }

  // ── Diagnostics (used by health endpoint / tests) ─────────────────────────

  get stats(): { active: number; queued: number; browserRunning: boolean } {
    return {
      active: this.active,
      queued: this.queue.length,
      browserRunning: this.browser?.isConnected() ?? false,
    };
  }
}

/** Singleton instance shared across all scrape requests in this process. */
export const browserPool = new BrowserPool();

// Export the class so unit tests can create isolated instances.
export { BrowserPool };
