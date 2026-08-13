import { Router, type IRouter } from "express";
import { browserPool } from "../scrapers/browser-pool.js";
import { config } from "../config.js";

const router: IRouter = Router();

/**
 * GET /api/healthz — existing health check (kept for backward compat).
 */
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * GET /api/health — PayerNews Scraper health endpoint as specified.
 */
router.get("/health", (_req, res) => {
  const { active, queued, browserRunning } = browserPool.stats;
  res.json({
    status: "healthy",
    service: "PayerNews Scraper",
    browserPool: {
      active,
      queued,
      browserRunning,
      maxContexts: config.playwrightMaxContexts,
      maxQueue: config.playwrightQueueLimit,
    },
  });
});

export default router;
