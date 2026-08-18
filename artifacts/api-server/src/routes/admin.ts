/**
 * Admin JSON API — mounted under /api/admin.
 *
 * GET  /api/admin/status    — dashboard status (admin session OR API bearer key)
 * GET  /api/admin/alerts    — alert state       (admin session OR API bearer key)
 * GET  /api/admin/me        — session info + CSRF token (session only)
 * GET  /api/admin/stats     — scrape statistics          (session only)
 * GET  /api/admin/requests  — request history w/ filters (session only)
 * GET  /api/admin/requests/:requestId                    (session only)
 * POST /api/admin/controls/(pause|resume|drain) — session + CSRF
 */

import { Router, type IRouter, type Response, type NextFunction } from "express";
import { browserPool } from "../scrapers/browser-pool.js";
import { config } from "../config.js";
import { getOpsState, setOpsMode, type OpsMode } from "../lib/ops-state.js";
import { getAlertStatus } from "../lib/alerts.js";
import {
  getScrapeStats,
  queryRequests,
  getRequestByRequestId,
  getActivityBuckets,
} from "../lib/request-log.js";
import {
  requireAdminApi,
  requireCsrf,
  type AdminRequest,
} from "../admin/middleware.js";
import { requireApiKey } from "../middleware/auth.js";
import { getSession, SESSION_COOKIE } from "../admin/sessions.js";

const router: IRouter = Router();

/**
 * Allow EITHER an admin session (dashboard) or the API bearer key
 * (Power Automate polling) for read-only status/alert endpoints.
 */
function requireSessionOrApiKey(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): void {
  const signed = (req as AdminRequest & {
    signedCookies?: Record<string, string>;
  }).signedCookies;
  const session = getSession(signed?.[SESSION_COOKIE]);
  if (session) {
    req.adminSession = session;
    next();
    return;
  }
  requireApiKey(req, res, next);
}

function poolSnapshot() {
  const { active, queued, browserRunning } = browserPool.stats;
  const maxContexts = config.playwrightMaxContexts;
  const maxQueue = config.playwrightQueueLimit;
  return {
    active,
    queued,
    browserRunning,
    maxContexts,
    maxQueue,
    utilisation: maxContexts > 0 ? Math.round((active / maxContexts) * 100) : 0,
    warnThresholdPct: Math.round(config.poolWarnThreshold * 100),
  };
}

router.get("/admin/status", requireSessionOrApiKey, async (_req, res) => {
  const pool = poolSnapshot();
  const ops = getOpsState();
  let statistics = null;
  try {
    const s = await getScrapeStats();
    statistics = {
      scrapesToday: s.scrapesToday,
      successesToday: s.successesToday,
      failuresToday: s.failuresToday,
      staticSuccessesToday: s.staticSuccessesToday,
      playwrightSuccessesToday: s.playwrightSuccessesToday,
      averageDurationMs: s.averageDurationMs,
    };
  } catch {
    // Stats are best-effort; status must still respond.
  }
  res.json({
    serviceStatus:
      pool.utilisation >= pool.warnThresholdPct ? "degraded" : "healthy",
    acceptingRequests: ops.acceptingRequests,
    mode: ops.mode,
    modeChangedAt: ops.changedAt,
    browserPool: pool,
    statistics,
  });
});

router.get("/admin/alerts", requireSessionOrApiKey, (_req, res) => {
  res.json(getAlertStatus());
});

router.get("/admin/me", requireAdminApi, (req: AdminRequest, res) => {
  res.json({
    username: req.adminSession?.username,
    csrfToken: req.adminSession?.csrfToken,
  });
});

router.get("/admin/stats", requireAdminApi, async (_req, res) => {
  res.json(await getScrapeStats());
});

router.get("/admin/activity", requireSessionOrApiKey, async (req, res) => {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const minutes = clamp(parseInt(String(req.query.minutes ?? "10"), 10) || 10, 1, 60);
  const bucketSecs = clamp(parseInt(String(req.query.bucketSecs ?? "30"), 10) || 30, 5, 300);
  let buckets: Awaited<ReturnType<typeof getActivityBuckets>> = [];
  try {
    buckets = await getActivityBuckets(minutes, bucketSecs);
  } catch {
    // Degrade gracefully — the dashboard still renders without activity data.
  }
  res.json({ buckets, bucketSecs, generatedAt: new Date().toISOString() });
});

router.get("/admin/requests", requireAdminApi, async (req, res) => {
  const q = req.query;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  const result = str(q.result);
  const scraper = str(q.scraper);
  const data = await queryRequests({
    search: str(q.search),
    result: result === "success" || result === "failure" ? result : undefined,
    scraper:
      scraper === "static" || scraper === "playwright" ? scraper : undefined,
    domain: str(q.domain),
    route: str(q.route),
    errorsOnly: q.errorsOnly === "true",
    page: q.page ? parseInt(String(q.page), 10) || 1 : 1,
    limit: q.limit ? parseInt(String(q.limit), 10) || 25 : 25,
  });
  res.json(data);
});

router.get("/admin/requests/:requestId", requireAdminApi, async (req, res) => {
  const row = await getRequestByRequestId(String(req.params.requestId));
  if (!row) {
    res.status(404).json({ success: false, error: "Request not found" });
    return;
  }
  res.json(row);
});

// ── Controls (POST-only, session + CSRF) ──────────────────────────────────────

const MODES: Record<string, OpsMode> = {
  pause: "paused",
  resume: "normal",
  drain: "drain",
};

for (const [action, mode] of Object.entries(MODES)) {
  router.post(
    `/admin/controls/${action}`,
    requireAdminApi,
    requireCsrf,
    (req: AdminRequest, res) => {
      setOpsMode(mode, req.adminSession?.username ?? "admin");
      res.json({ success: true, ...getOpsState() });
    },
  );
}

export default router;
