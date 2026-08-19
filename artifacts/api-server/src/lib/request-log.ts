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

// ── Sensitive-data redaction ─────────────────────────────────────────────────
//
// URLs can legitimately contain credentials (user:pass@host), API tokens in
// query parameters, signed-URL signatures, or OAuth codes. History rows live
// for `logRetentionDays`, so all persisted URLs and error messages are
// sanitized first: userinfo is stripped and sensitive query params redacted.

const SENSITIVE_PARAM = /(token|key|secret|password|passwd|pwd|auth|signature|sig|credential|bearer|jwt|session|code|x-amz-[a-z-]+)/i;

/**
 * Sanitize a single URL-ish string (non-recursive). Parseable URLs get
 * userinfo stripped and sensitive query params redacted; HTTP-like strings
 * that cannot be parsed FAIL CLOSED and are replaced wholesale (they may
 * contain malformed credential material we cannot safely pick apart).
 */
function sanitizeSingleUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    // Fragments are never sent to the server and commonly carry OAuth
    // implicit-flow credentials (#access_token=...) — drop them entirely.
    u.hash = "";
    for (const name of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) u.searchParams.set(name, "REDACTED");
    }
    return u.toString();
  } catch {
    return "REDACTED-UNPARSEABLE-URL";
  }
}

/** Strip userinfo and redact sensitive query parameter values. */
export function sanitizeUrlForLog(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  if (/^https?:\/\//i.test(rawUrl.trim())) return sanitizeSingleUrl(rawUrl.trim());
  // Not HTTP-like (e.g. "not a url"): keep, but redact any embedded URLs.
  return sanitizeText(rawUrl);
}

/** Redact URLs embedded in free text (e.g. error messages). Non-recursive. */
export function sanitizeText(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, (m) => sanitizeSingleUrl(m));
}

/**
 * Record a completed scrape request. Fire-and-forget: logging must never
 * break the scrape response path. URLs and error text are sanitized here —
 * the single choke point before persistence.
 */
export function recordScrapeRequest(row: InsertScrapeRequest): void {
  const safeRow: InsertScrapeRequest = {
    ...row,
    url: sanitizeUrlForLog(row.url),
    finalUrl: row.finalUrl ? sanitizeUrlForLog(row.finalUrl) : row.finalUrl,
    errorMessage: row.errorMessage ? sanitizeText(row.errorMessage) : row.errorMessage,
  };
  void (async () => {
    const m = await getDbModule();
    if (!m) return;
    await m.db.insert(m.scrapeRequestsTable).values(safeRow);
  })().catch((err: unknown) => {
    logger.warn({ err, requestId: row.requestId }, "Failed to persist scrape request log");
  });
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface RequestQuery {
  search?: string; // matches request ID, URL, or domain
  result?: "success" | "failure";
  scraper?: "static" | "playwright" | "pdf-native" | "pdf-ocr" | "pdf-mixed";
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
  pdfsProcessed: number;
  nativePdfExtractions: number;
  ocrPdfExtractions: number;
  mixedPdfExtractions: number;
  pdfFailures: number;
  averagePdfDurationMs: number;
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
  pdfsProcessed: 0,
  nativePdfExtractions: 0,
  ocrPdfExtractions: 0,
  mixedPdfExtractions: 0,
  pdfFailures: 0,
  averagePdfDurationMs: 0,
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
        pdfsProcessed: count(
          sql`CASE WHEN ${t.documentType} = 'pdf' THEN 1 END`,
        ),
        nativePdfExtractions: count(
          sql`CASE WHEN ${t.success} AND ${t.scraperUsed} = 'pdf-native' THEN 1 END`,
        ),
        ocrPdfExtractions: count(
          sql`CASE WHEN ${t.success} AND ${t.scraperUsed} = 'pdf-ocr' THEN 1 END`,
        ),
        mixedPdfExtractions: count(
          sql`CASE WHEN ${t.success} AND ${t.scraperUsed} = 'pdf-mixed' THEN 1 END`,
        ),
        pdfFailures: count(
          sql`CASE WHEN ${t.documentType} = 'pdf' AND NOT ${t.success} THEN 1 END`,
        ),
        averagePdfDurationMs: sql<number | null>`AVG(CASE WHEN ${t.documentType} = 'pdf' THEN ${t.durationMs} END)`,
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
    pdfsProcessed: w.pdfsProcessed,
    nativePdfExtractions: w.nativePdfExtractions,
    ocrPdfExtractions: w.ocrPdfExtractions,
    mixedPdfExtractions: w.mixedPdfExtractions,
    pdfFailures: w.pdfFailures,
    averagePdfDurationMs: Math.round(Number(w.averagePdfDurationMs ?? 0)),
  };
}

// ── Activity buckets ─────────────────────────────────────────────────────────

export interface ActivityBucket {
  ts: number; // Unix epoch seconds (start of bucket)
  static: number;
  playwright: number;
  pdf: number;
}

/**
 * Return time-bucketed scrape counts for the last `minutes` minutes.
 *
 * Empty buckets are filled with zeros so callers always receive exactly
 * `Math.ceil(minutes * 60 / bucketSecs)` entries. Falls back to an all-zero
 * series when the database is unavailable.
 */
export async function getActivityBuckets(
  minutes = 10,
  bucketSecs = 30,
): Promise<ActivityBucket[]> {
  const totalBuckets = Math.ceil((minutes * 60) / bucketSecs);

  // Anchor the window on the current aligned bucket so "now" is always the
  // rightmost bar. Work backwards so the current partial bucket is included.
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSecs) * bucketSecs;

  const map = new Map<number, ActivityBucket>();
  for (let i = 0; i < totalBuckets; i++) {
    const ts = nowBucket - (totalBuckets - 1 - i) * bucketSecs;
    map.set(ts, { ts, static: 0, playwright: 0, pdf: 0 });
  }

  const m = await getDbModule();
  if (!m) return [...map.values()].sort((a, b) => a.ts - b.ts);

  const { db, scrapeRequestsTable: t } = m;
  // Cover from the oldest bucket start through the end of the current bucket.
  const since = new Date((nowBucket - (totalBuckets - 1) * bucketSecs) * 1000);

  const bSecs = sql.raw(String(bucketSecs));
  try {
    const rows = await db
      .select({
        bucketTs: sql<number>`floor(extract(epoch from ${t.createdAt}) / ${bSecs}) * ${bSecs}`,
        staticCount: count(sql`CASE WHEN ${t.scraperUsed} = 'static' THEN 1 END`),
        playwrightCount: count(sql`CASE WHEN ${t.scraperUsed} = 'playwright' THEN 1 END`),
        pdfCount: count(sql`CASE WHEN ${t.documentType} = 'pdf' THEN 1 END`),
      })
      .from(t)
      .where(gte(t.createdAt, since))
      .groupBy(sql`floor(extract(epoch from ${t.createdAt}) / ${bSecs}) * ${bSecs}`)
      .orderBy(sql`floor(extract(epoch from ${t.createdAt}) / ${bSecs}) * ${bSecs}`);

    for (const row of rows) {
      const ts = Number(row.bucketTs);
      if (map.has(ts)) {
        map.set(ts, {
          ts,
          static: Number(row.staticCount),
          playwright: Number(row.playwrightCount),
          pdf: Number(row.pdfCount),
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "Activity bucket query failed — returning zero series");
  }

  return [...map.values()].sort((a, b) => a.ts - b.ts);
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
