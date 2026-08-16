/**
 * Persistent scrape request history (Postgres via @workspace/db).
 *
 * Stores metadata only — never full page content, tokens, or credentials.
 * Optionally keeps a 500-char content preview for diagnostics.
 * Rows older than `config.logRetentionDays` are pruned hourly.
 */

import { randomBytes } from "node:crypto";
import type {
  InsertScrapeRequest,
  ScrapeRequestRecord,
} from "@workspace/db";
import { and, count, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "./logger.js";

export const PREVIEW_MAX_CHARS = 500;

/**
 * Lazy, fault-tolerant access to the database module.
 *
 * `@workspace/db` throws at module load when DATABASE_URL is unset. The
 * scraper API must keep working without a database (history is then simply
 * disabled), so the module is loaded lazily and failures are logged once.
 */
type DbModule = typeof import("@workspace/db");
let dbModule: DbModule | null | undefined;

async function getDbModule(): Promise<DbModule | null> {
  if (dbModule !== undefined) return dbModule;
  try {
    dbModule = await import("@workspace/db");
  } catch (err) {
    dbModule = null;
    logger.warn(
      { err },
      "Request history database unavailable (is DATABASE_URL set?) — scrape history is disabled",
    );
  }
  return dbModule;
}

/** Generate a human-readable request ID, e.g. PN-20260815-A38F91 */
export function generateRequestId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return `PN-${y}${m}${d}-${suffix}`;
}

/** Extract a hostname for filtering/search; empty string when unparseable. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Record a completed scrape request. Fire-and-forget: logging must never
 * break the scrape response path.
 */
export function recordScrapeRequest(row: InsertScrapeRequest): void {
  void (async () => {
    const m = await getDbModule();
    if (!m) return;
    await m.db.insert(m.scrapeRequestsTable).values(row);
  })().catch((err: unknown) => {
    logger.warn({ err, requestId: row.requestId }, "Failed to persist scrape request log");
  });
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface RequestQuery {
  search?: string; // matches request ID, URL, or domain
  result?: "success" | "failure";
  scraper?: "static" | "playwright";
  domain?: string;
  route?: string;
  errorsOnly?: boolean;
  page?: number; // 1-based
  limit?: number;
}

export async function queryRequests(q: RequestQuery): Promise<{
  rows: ScrapeRequestRecord[];
  total: number;
  page: number;
  pageCount: number;
  limit: number;
}> {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  const page = Math.max(q.page ?? 1, 1);

  const m = await getDbModule();
  if (!m) return { rows: [], total: 0, page, pageCount: 1, limit };
  const { db, scrapeRequestsTable } = m;

  const conds = [];
  if (q.result === "success") conds.push(eq(scrapeRequestsTable.success, true));
  if (q.result === "failure" || q.errorsOnly)
    conds.push(eq(scrapeRequestsTable.success, false));
  if (q.scraper) conds.push(eq(scrapeRequestsTable.scraperUsed, q.scraper));
  if (q.domain)
    conds.push(ilike(scrapeRequestsTable.domain, `%${escapeLike(q.domain)}%`));
  if (q.route) conds.push(eq(scrapeRequestsTable.route, q.route));
  if (q.search) {
    const term = `%${escapeLike(q.search)}%`;
    conds.push(
      or(
        ilike(scrapeRequestsTable.requestId, term),
        ilike(scrapeRequestsTable.url, term),
        ilike(scrapeRequestsTable.domain, term),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select()
      .from(scrapeRequestsTable)
      .where(where)
      .orderBy(desc(scrapeRequestsTable.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(scrapeRequestsTable).where(where),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    limit,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export async function getRequestByRequestId(
  requestId: string,
): Promise<ScrapeRequestRecord | undefined> {
  const m = await getDbModule();
  if (!m) return undefined;
  const { db, scrapeRequestsTable } = m;
  const rows = await db
    .select()
    .from(scrapeRequestsTable)
    .where(eq(scrapeRequestsTable.requestId, requestId))
    .limit(1);
  return rows[0];
}

// ── Statistics ────────────────────────────────────────────────────────────────

export interface ScrapeStats {
  scrapesToday: number;
  successesToday: number;
  failuresToday: number;
  staticSuccessesToday: number;
  playwrightSuccessesToday: number;
  scrapesLast24h: number;
  scrapesThisWeek: number;
  successRatePct: number; // over last 7 days
  playwrightFallbackRatePct: number; // over last 7 days
  averageDurationMs: number;
  medianDurationMs: number;
  longestDurationMs: number;
}

const EMPTY_STATS: ScrapeStats = {
  scrapesToday: 0,
  successesToday: 0,
  failuresToday: 0,
  staticSuccessesToday: 0,
  playwrightSuccessesToday: 0,
  scrapesLast24h: 0,
  scrapesThisWeek: 0,
  successRatePct: 0,
  playwrightFallbackRatePct: 0,
  averageDurationMs: 0,
  medianDurationMs: 0,
  longestDurationMs: 0,
};

export async function getScrapeStats(): Promise<ScrapeStats> {
  const m = await getDbModule();
  if (!m) return EMPTY_STATS;
  const { db, scrapeRequestsTable } = m;
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const t = scrapeRequestsTable;

  const [todayRows, windowRows] = await Promise.all([
    db
      .select({
        total: count(),
        successes: count(sql`CASE WHEN ${t.success} THEN 1 END`),
        staticSuccesses: count(
          sql`CASE WHEN ${t.success} AND ${t.scraperUsed} = 'static' THEN 1 END`,
        ),
        playwrightSuccesses: count(
          sql`CASE WHEN ${t.success} AND ${t.scraperUsed} = 'playwright' THEN 1 END`,
        ),
      })
      .from(t)
      .where(gte(t.createdAt, startOfToday)),
    db
      .select({
        last24h: count(sql`CASE WHEN ${t.createdAt} >= ${dayAgo} THEN 1 END`),
        week: count(),
        weekSuccesses: count(sql`CASE WHEN ${t.success} THEN 1 END`),
        weekPlaywright: count(
          sql`CASE WHEN ${t.playwrightFallback} THEN 1 END`,
        ),
        avgMs: sql<number | null>`AVG(${t.durationMs})`,
        medianMs: sql<number | null>`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${t.durationMs})`,
        maxMs: sql<number | null>`MAX(${t.durationMs})`,
      })
      .from(t)
      .where(gte(t.createdAt, weekAgo)),
  ]);

  const today = todayRows[0];
  const w = windowRows[0];

  return {
    scrapesToday: today.total,
    successesToday: today.successes,
    failuresToday: today.total - today.successes,
    staticSuccessesToday: today.staticSuccesses,
    playwrightSuccessesToday: today.playwrightSuccesses,
    scrapesLast24h: w.last24h,
    scrapesThisWeek: w.week,
    successRatePct: w.week > 0 ? Math.round((w.weekSuccesses / w.week) * 100) : 0,
    playwrightFallbackRatePct:
      w.week > 0 ? Math.round((w.weekPlaywright / w.week) * 100) : 0,
    averageDurationMs: Math.round(Number(w.avgMs ?? 0)),
    medianDurationMs: Math.round(Number(w.medianMs ?? 0)),
    longestDurationMs: Math.round(Number(w.maxMs ?? 0)),
  };
}

// ── Retention ─────────────────────────────────────────────────────────────────

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

export async function pruneOldRequests(): Promise<number> {
  const m = await getDbModule();
  if (!m) return 0;
  const { db, scrapeRequestsTable } = m;
  const cutoff = new Date(
    Date.now() - config.logRetentionDays * 24 * 3600 * 1000,
  );
  const deleted = await db
    .delete(scrapeRequestsTable)
    .where(lt(scrapeRequestsTable.createdAt, cutoff))
    .returning({ id: scrapeRequestsTable.id });
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, retentionDays: config.logRetentionDays },
      "Pruned old scrape request logs",
    );
  }
  return deleted.length;
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Prune at boot and then hourly. Safe to call once. */
export function startRetentionPruning(): void {
  if (pruneTimer) return;
  void pruneOldRequests().catch((err: unknown) =>
    logger.warn({ err }, "Retention pruning failed"),
  );
  pruneTimer = setInterval(() => {
    void pruneOldRequests().catch((err: unknown) =>
      logger.warn({ err }, "Retention pruning failed"),
    );
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
}
