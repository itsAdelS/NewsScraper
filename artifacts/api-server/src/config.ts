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
} as const;

/** User-agent string sent with all scraper HTTP requests. */
export const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (compatible; PayerNewsScraper/1.0; +https://payernews.internal)";
