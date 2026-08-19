import { Router, type IRouter } from "express";
import { browserPool } from "../scrapers/browser-pool.js";
import { pdfPool } from "../scrapers/pdf-pool.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/**
 * GET /api/healthz — existing health check (kept for backward compat).
 */
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * GET /api/health — PayerNews Scraper health endpoint as specified.
 *
 * Returns `status: "degraded"` and emits a warning log when the browser pool
 * utilisation reaches or exceeds `config.poolWarnThreshold` (default 80 %).
 */
router.get("/health", (_req, res) => {
  const { active, queued, browserRunning } = browserPool.stats;
  const { playwrightMaxContexts: maxContexts, playwrightQueueLimit: maxQueue, poolWarnThreshold } = config;

  const utilisation = maxContexts > 0 ? active / maxContexts : 0;
  const isNearCapacity = utilisation >= poolWarnThreshold;

  if (isNearCapacity) {
    logger.warn(
      {
        active,
        maxContexts,
        utilisation: Math.round(utilisation * 100),
        threshold: Math.round(poolWarnThreshold * 100),
      },
      "Browser pool: near capacity — health degraded",
    );
  }

  const status = isNearCapacity ? "degraded" : "healthy";

  res.json({
    status,
    service: "PayerNews Scraper",
    browserPool: {
      active,
      queued,
      browserRunning,
      maxContexts,
      maxQueue,
      utilisation: Math.round(utilisation * 100),
      warnThresholdPct: Math.round(poolWarnThreshold * 100),
    },
    pdfPool: pdfPool.stats,
  });
});

export default router;
