/**
 * Bounded concurrency pool for PDF OCR operations.
 *
 * Independent of the browser pool — PDF work is CPU/IO-bound (Python worker +
 * Tesseract) and must not compete with the Playwright quota.
 *
 * Follows the same semaphore pattern as BrowserPool:
 *   - At most `config.maxConcurrentPdfOcr` jobs may run simultaneously.
 *   - Additional requests wait in a FIFO queue capped at `config.pdfMaxQueue`.
 *   - When both are full, `PdfPoolFullError` is thrown (→ HTTP 503).
 */

import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/** Thrown when the PDF pool queue is full. Callers should return HTTP 503. */
export class PdfPoolFullError extends Error {
  constructor() {
    super("PDF processing queue is full — try again shortly");
    this.name = "PdfPoolFullError";
  }
}

/** Thrown when the PDF worker times out. Callers should return HTTP 504. */
export class PdfTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    phase: "download" | "queue" | "extraction" = "extraction",
  ) {
    super(`PDF ${phase} timed out after ${timeoutMs}ms`);
    this.name = "PdfTimeoutError";
  }
}

export class PdfPool {
  private active = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> =
    [];

  /**
   * Run `fn` inside the pool, acquiring a slot first.
   * Throws PdfPoolFullError when the queue is also full.
   */
  async run<T>(fn: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
    const { maxConcurrentPdfOcr: maxActive, pdfMaxQueue: maxQ } = config;

    if (this.active < maxActive) {
      this.active++;
    } else if (this.queue.length < maxQ) {
      logger.info(
        { active: this.active, queued: this.queue.length + 1, maxActive },
        "PDF pool: at capacity, queuing request",
      );
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject };
        this.queue.push(waiter);
        if (waitTimeoutMs !== undefined) {
          const timer = setTimeout(() => {
            const index = this.queue.indexOf(waiter);
            if (index >= 0) {
              this.queue.splice(index, 1);
              reject(new PdfTimeoutError(waitTimeoutMs, "queue"));
            }
          }, waitTimeoutMs);
          const originalResolve = waiter.resolve;
          waiter.resolve = () => {
            clearTimeout(timer);
            originalResolve();
          };
        }
      });
      // release() hands this queued request an already-reserved slot, so it
      // must not increment active again after resuming.
    } else {
      logger.warn(
        { active: this.active, queued: this.queue.length, maxActive, maxQ },
        "PDF pool: queue full, rejecting request",
      );
      throw new PdfPoolFullError();
    }

    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Atomic handoff: keep active unchanged while transferring this slot to
      // the queued waiter. New arrivals continue to see the slot as occupied.
      next.resolve();
    } else {
      this.active--;
    }
    logger.debug({ active: this.active, queued: this.queue.length }, "PDF pool: slot released");
  }

  get stats(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    maxQueue: number;
  } {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: config.maxConcurrentPdfOcr,
      maxQueue: config.pdfMaxQueue,
    };
  }
}

/** Singleton PDF concurrency pool. */
export const pdfPool = new PdfPool();
