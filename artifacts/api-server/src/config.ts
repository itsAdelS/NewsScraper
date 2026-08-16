/**
 * Centralised, environment-configurable limits and settings.
 * Never put secrets here — read them from process.env at point of use.
 */
export const config = {
  /** Maximum time in milliseconds the scraper may run before timing out. */
  maxScraperTimeoutMs: parseInt(process.env.SCRAPER_TIMEOUT_MS ?? "30000", 10),

  /** Maximum number of HTTP redirects to follow. */
  maxRedirects: parseInt(process.env.MAX_REDIRECTS ?? "5", 10),

  /** Maximum response body size in bytes (default: 10 MB). */
  maxBodyBytes: parseInt(
    process.env.MAX_BODY_BYTES ?? String(10 * 1024 * 1024),
    10,
  ),

  /** Maximum number of characters returned in the content field. */
  maxExtractedChars: parseInt(process.env.MAX_EXTRACTED_CHARS ?? "500000", 10),

  /**
   * Minimum character count for extracted text to be considered
   * "meaningful" content. Below this threshold the scraper falls back
   * or reports failure.
   */
  minMeaningfulChars: parseInt(process.env.MIN_MEANINGFUL_CHARS ?? "200", 10),

  /**
   * Maximum number of Playwright browser contexts that may be open at once.
   * Requests beyond this cap wait in a queue rather than launching a new
   * Chromium process.  Tune based on available memory (each context uses
   * roughly 50–100 MB on top of the shared Chromium process).
   */
  playwrightMaxContexts: parseInt(
    process.env.PLAYWRIGHT_MAX_CONTEXTS ?? "4",
    10,
  ),

  /**
   * Maximum number of requests that may wait in the browser-pool queue.
   * If this is exceeded, the API returns HTTP 503.  Set high enough that
   * normal burst traffic queues without being rejected.
   */
  playwrightQueueLimit: parseInt(
    process.env.PLAYWRIGHT_MAX_QUEUE ?? "20",
    10,
  ),

  /**
   * Fraction of `playwrightMaxContexts` at which the pool is considered
   * "near capacity".  When `active / maxContexts >= poolWarnThreshold` the
   * health endpoint returns `status: "degraded"` and a warning is logged.
   *
   * Accepts any value in (0, 1].  Default: 0.8 (warn at 80% utilisation).
   */
  poolWarnThreshold: parseFloat(process.env.POOL_WARN_THRESHOLD ?? "0.8"),

  // ── Admin console ───────────────────────────────────────────────────────────

  /** Admin session lifetime in hours (sliding — refreshed on activity). */
  adminSessionHours: parseFloat(process.env.ADMIN_SESSION_HOURS ?? "8"),

  /** Max failed admin logins per IP within the lockout window. */
  adminLoginMaxAttempts: parseInt(
    process.env.ADMIN_LOGIN_MAX_ATTEMPTS ?? "5",
    10,
  ),

  /** Lockout window for failed admin logins, in minutes. */
  adminLoginWindowMinutes: parseInt(
    process.env.ADMIN_LOGIN_WINDOW_MINUTES ?? "15",
    10,
  ),

  /** Days to retain scrape request history rows. */
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS ?? "30", 10),

  /** Store a 500-char diagnostic preview of extracted content per request. */
  logContentPreview:
    (process.env.LOG_CONTENT_PREVIEW ?? "true").toLowerCase() !== "false",

  /** retryAfterSeconds hint returned while scraping is paused. */
  pauseRetryAfterSeconds: parseInt(
    process.env.PAUSE_RETRY_AFTER_SECONDS ?? "300",
    10,
  ),
} as const;

/** User-agent string sent with all scraper HTTP requests. */
export const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (compatible; PayerNewsScraper/1.0; +https://payernews.internal)";
