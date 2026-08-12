import { Router, type IRouter } from "express";

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
  res.json({ status: "healthy", service: "PayerNews Scraper" });
});

export default router;
