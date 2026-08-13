/**
 * Tests for GET /api/health — verifying that browserPool counts in the
 * response accurately reflect real pool state under concurrent load.
 *
 * Strategy
 * --------
 * Every test resets the module registry (vi.resetModules) and registers a
 * Playwright mock BEFORE importing browser-pool or the health router.  This
 * guarantees:
 *
 *   1. The real `browserPool` singleton (from browser-pool.ts) is freshly
 *      instantiated for each test — no state leakage between tests.
 *   2. The health router imported in the same test shares that SAME singleton
 *      (module cache is shared within the reset boundary), so hitting
 *      GET /api/health exercises the real connection between the router and
 *      the pool.
 *   3. Setting PLAYWRIGHT_MAX_CONTEXTS before the reset means `config` is
 *      imported fresh and the concurrency cap is exactly what the test expects.
 *   4. No real Chromium process is launched; playwright.chromium.launch is
 *      mocked to return a lightweight in-memory fake.
 *
 * Test cases
 * ----------
 *  [A] Idle state   — browser not running, counts zero before any acquire
 *  [B] Active state — health endpoint reports accurate active count while
 *                     contexts are held by concurrent requests
 *  [C] Queued state — health endpoint reports accurate queued count while
 *                     requests wait for a free slot
 *  [D] Recovery     — counts return to zero after all contexts are released
 *  [F] Disconnect   — active resets to 0 and queued waiters are rejected on crash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import type { BrowserPool } from "../scrapers/browser-pool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Chromium browser whose newContext resolves immediately with a
 * context whose close() is a no-op.  Stores the `on` spy so tests can
 * optionally inspect it.
 */
function makeFakeBrowser() {
  const fakeBrowser = {
    isConnected: vi.fn().mockReturnValue(true),
    // Each call returns a NEW distinct context object so that WeakMap entries
    // don't collide when multiple contexts are held simultaneously.
    newContext: vi.fn().mockImplementation(() =>
      Promise.resolve({ close: vi.fn().mockResolvedValue(undefined) }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
  return { fakeBrowser };
}

/**
 * Reset the module registry, register the playwright mock with a fresh fake
 * browser, optionally pin PLAYWRIGHT_MAX_CONTEXTS, then import and return:
 *   - `pool`        the real browserPool singleton (fresh instance)
 *   - `healthRouter` the real health router (wired to the same pool)
 *
 * Must be called inside a test or beforeEach AFTER vi.resetModules().
 */
async function buildTestEnv(maxContexts = 2) {
  // Pin config values BEFORE modules are imported.
  process.env.PLAYWRIGHT_MAX_CONTEXTS = String(maxContexts);
  process.env.PLAYWRIGHT_MAX_QUEUE = "20";

  vi.resetModules();

  const { fakeBrowser } = makeFakeBrowser();
  vi.doMock("playwright", () => ({
    chromium: { launch: vi.fn().mockResolvedValue(fakeBrowser) },
  }));

  // Import in dependency order so the module cache is shared.
  const { browserPool: pool } = await import("../scrapers/browser-pool.js");
  const { default: healthRouter } = await import("../routes/health.js");

  const app = express();
  app.use("/api", healthRouter);

  return { pool: pool as BrowserPool, app, fakeBrowser };
}

/**
 * Fire the "disconnected" event that the pool registered on the browser.
 * The pool calls `b.on("disconnected", handler)` — we grab that handler
 * from the `on` spy and invoke it directly to simulate a crash.
 */
function simulateDisconnect(fakeBrowser: ReturnType<typeof makeFakeBrowser>["fakeBrowser"]): void {
  const calls = fakeBrowser.on.mock.calls as Array<[string, () => void]>;
  const disconnectedCall = calls.find(([event]) => event === "disconnected");
  if (!disconnectedCall) throw new Error("No 'disconnected' listener registered on fake browser");
  disconnectedCall[1]();
}

// ---------------------------------------------------------------------------
// Teardown helper — shut the pool down and clean up mocks/env.
// ---------------------------------------------------------------------------
async function teardown(pool: BrowserPool) {
  try {
    await pool.shutdown();
  } catch {
    // Already shut down — safe to ignore.
  }
  delete process.env.PLAYWRIGHT_MAX_CONTEXTS;
  delete process.env.PLAYWRIGHT_MAX_QUEUE;
  vi.doUnmock("playwright");
  vi.resetModules();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("GET /api/health — real router wired to real pool (playwright mocked)", () => {
  let pool: BrowserPool;
  let app: express.Express;

  afterEach(async () => {
    await teardown(pool);
  });

  // ── [A] Idle state ─────────────────────────────────────────────────────────

  it("[A] returns healthy status with correct shape before any scrape request", async () => {
    ({ pool, app } = await buildTestEnv());

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "healthy",
      service: "PayerNews Scraper",
    });
    expect(res.body.browserPool).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
      browserRunning: expect.any(Boolean),
      maxContexts: expect.any(Number),
      maxQueue: expect.any(Number),
    });
  });

  it("[A] idle pool: browserRunning is false and active/queued are 0", async () => {
    ({ pool, app } = await buildTestEnv());

    const res = await request(app).get("/api/health");

    expect(res.body.browserPool).toMatchObject({
      active: 0,
      queued: 0,
      browserRunning: false,
    });
  });

  // ── [B] Active state ────────────────────────────────────────────────────────

  it("[B] active:1 — health reports one held context while it is open", async () => {
    ({ pool, app } = await buildTestEnv());

    const ctx = await pool.acquire();

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(1);
    expect(res.body.browserPool.queued).toBe(0);
    expect(res.body.browserPool.browserRunning).toBe(true);

    await pool.release(ctx);
  });

  it("[B] active:2 — health reflects two concurrently held contexts", async () => {
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 3));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);
    expect(res.body.browserPool.queued).toBe(0);
    expect(res.body.browserPool.browserRunning).toBe(true);

    await pool.release(ctx1);
    await pool.release(ctx2);
  });

  it("[B] active count decrements correctly as contexts are released", async () => {
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 3));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    // Both held.
    let res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);

    await pool.release(ctx1);

    // One released.
    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(1);

    await pool.release(ctx2);

    // All released.
    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
  });

  // ── [C] Queued state ────────────────────────────────────────────────────────

  it("[C] queued:1 — health reports one waiting request when pool is full", async () => {
    // maxContexts=2: fill both slots, then enqueue a third.
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 2));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    // Pool is now at capacity.  Start a third acquire without awaiting it so
    // it parks in the queue.
    const pendingAcquire = pool.acquire();

    // One microtask tick is enough for the waiter to be pushed onto the queue.
    await Promise.resolve();

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);
    expect(res.body.browserPool.queued).toBe(1);
    expect(res.body.browserPool.browserRunning).toBe(true);

    // Release a slot so the waiter can proceed, then clean up.
    await pool.release(ctx1);
    await Promise.resolve();
    const ctx3 = await pendingAcquire;
    await pool.release(ctx2);
    await pool.release(ctx3);
  });

  it("[C] queued:2 — health reports two waiting requests when pool is full", async () => {
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 2));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    const pending1 = pool.acquire();
    const pending2 = pool.acquire();

    await Promise.resolve();

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);
    expect(res.body.browserPool.queued).toBe(2);

    // Clean up.
    await pool.release(ctx1);
    await pool.release(ctx2);
    const c3 = await pending1;
    const c4 = await pending2;
    await pool.release(c3);
    await pool.release(c4);
  });

  // ── [D] Recovery ────────────────────────────────────────────────────────────

  it("[D] counts return to zero after all contexts are released", async () => {
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 2));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();
    await pool.release(ctx1);
    await pool.release(ctx2);

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
    expect(res.body.browserPool.queued).toBe(0);
    // Browser stays open (idle timer hasn't fired yet).
    expect(res.body.browserPool.browserRunning).toBe(true);
  });

  it("[D] browserRunning is false after pool is shut down", async () => {
    ({ pool, app } = await buildTestEnv());

    const ctx = await pool.acquire();
    await pool.release(ctx);
    await pool.shutdown();

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.browserRunning).toBe(false);
  });

  // ── [E] Response contract ───────────────────────────────────────────────────

  it("[E] maxContexts in response matches the configured cap", async () => {
    ({ pool, app } = await buildTestEnv(/* maxContexts= */ 2));

    const res = await request(app).get("/api/health");
    expect(res.body.browserPool.maxContexts).toBe(2);
  });

  it("[E] always returns JSON content-type", async () => {
    ({ pool, app } = await buildTestEnv());

    const res = await request(app).get("/api/health");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  // ── [F] Disconnect / crash recovery ────────────────────────────────────────

  it("[F] active resets to 0 after Chromium disconnects unexpectedly", async () => {
    let fakeBrowser: ReturnType<typeof makeFakeBrowser>["fakeBrowser"];
    ({ pool, app, fakeBrowser } = await buildTestEnv(/* maxContexts= */ 2));

    // Hold two contexts so active === 2.
    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    let res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);

    // Simulate an OOM kill / unexpected disconnect.
    simulateDisconnect(fakeBrowser);

    // active must be reset immediately — no release() calls needed.
    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
    expect(res.body.browserPool.browserRunning).toBe(false);

    // Production finally blocks call release() on orphaned contexts.
    // active must stay at 0 (not go negative) after these late returns.
    await pool.release(ctx1);
    await pool.release(ctx2);

    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
  });

  it("[F] queued waiters are rejected (not left hanging) after a browser crash", async () => {
    let fakeBrowser: ReturnType<typeof makeFakeBrowser>["fakeBrowser"];
    ({ pool, app, fakeBrowser } = await buildTestEnv(/* maxContexts= */ 2));

    // Fill the pool so the next acquire parks in the queue.
    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    // Start a waiter — it will sit in the queue because the pool is full.
    const pendingAcquire = pool.acquire();
    await Promise.resolve(); // let it reach the queue

    // Confirm it is queued.
    let res = await request(app).get("/api/health");
    expect(res.body.browserPool.queued).toBe(1);

    // Simulate a crash — the waiter must be rejected, not left indefinitely.
    simulateDisconnect(fakeBrowser);

    await expect(pendingAcquire).rejects.toThrow(
      /disconnected unexpectedly/i,
    );

    // After the crash, the queue must be drained.
    res = await request(app).get("/api/health");
    expect(res.body.browserPool.queued).toBe(0);
    expect(res.body.browserPool.active).toBe(0);

    // Production finally blocks release orphaned contexts — active must stay 0.
    await pool.release(ctx1);
    await pool.release(ctx2);

    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
  });

  it("[F] new context acquired and released before orphan releases: active stays correct", async () => {
    // This is the key interleaving scenario: crash with 2 old contexts, then a
    // new request runs to completion (acquire + release), and THEN the old
    // finally blocks call release() on the orphaned contexts.
    // The global-absorber (discardedSlots) approach incorrectly lets the new
    // release consume a discard credit; the generation-aware approach must not.
    let fakeBrowser: ReturnType<typeof makeFakeBrowser>["fakeBrowser"];
    ({ pool, app, fakeBrowser } = await buildTestEnv(/* maxContexts= */ 2));

    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();

    simulateDisconnect(fakeBrowser);

    // New request on the fresh browser (active should go 0→1→0).
    const newCtx = await pool.acquire();
    let res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(1);

    await pool.release(newCtx);

    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);

    // Now the orphaned finally blocks run — active must remain 0.
    await pool.release(ctx1);
    await pool.release(ctx2);

    res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(0);
  });

  it("[F] concurrency cap is respected on new requests after crash + orphan releases", async () => {
    let fakeBrowser: ReturnType<typeof makeFakeBrowser>["fakeBrowser"];
    ({ pool, app, fakeBrowser } = await buildTestEnv(/* maxContexts= */ 2));

    // Acquire two contexts, then crash.
    const ctx1 = await pool.acquire();
    const ctx2 = await pool.acquire();
    simulateDisconnect(fakeBrowser);

    // Orphaned releases from pre-crash finally blocks (BEFORE any new work).
    await pool.release(ctx1);
    await pool.release(ctx2);

    // Pool is now at active=0.  Acquire up to the cap on a fresh browser.
    const newCtx1 = await pool.acquire();
    const newCtx2 = await pool.acquire();

    let res = await request(app).get("/api/health");
    expect(res.body.browserPool.active).toBe(2);

    // A third acquire must queue (cap is 2).
    const pendingAcquire = pool.acquire();
    await Promise.resolve();

    res = await request(app).get("/api/health");
    expect(res.body.browserPool.queued).toBe(1);
    expect(res.body.browserPool.active).toBe(2);

    // Clean up.
    await pool.release(newCtx1);
    const newCtx3 = await pendingAcquire;
    await pool.release(newCtx2);
    await pool.release(newCtx3);
  });
});
