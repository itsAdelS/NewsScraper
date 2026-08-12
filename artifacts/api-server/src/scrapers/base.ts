/**
 * BaseScraper — shared foundation for all payer scrapers.
 *
 * Subclasses override extractContent() to add payer-specific extraction
 * rules without duplicating the generic scraping pipeline.
 */

import { config } from "../config.js";
import { extractText, extractTitle, isMeaningful } from "../utils/cleanup.js";
import type { EngineResult, IScraper } from "./types.js";
import { logger } from "../lib/logger.js";

export { safeFetch } from "../utils/safe-fetch.js";
export type { SafeFetchResult as FetchedPage } from "../utils/safe-fetch.js";

/**
 * Abstract base class for all scrapers.
 *
 * Provides the shared extraction pipeline; subclasses may override
 * postProcessContent() to add payer-specific cleaning or parsing.
 */
export abstract class BaseScraper implements IScraper {
  abstract scrape(url: string, requestId: string): Promise<EngineResult>;

  /**
   * Hook for payer-specific post-processing of the extracted text.
   * Base implementation is a no-op — subclasses override as needed.
   */
  protected postProcessContent(content: string, _url: string): string {
    return content;
  }

  /**
   * Shared HTML → EngineResult pipeline used by both static and browser
   * scrapers.  Applies postProcessContent() after generic extraction.
   *
   * Success rules:
   *  - The target server must have returned a 2xx status code.
   *  - The extracted text must pass the meaningful-content heuristics.
   *
   * Non-2xx pages (404, 403, 5xx …) are always failures even if they
   * contain readable text — a "Page Not Found" error page should not be
   * forwarded to Power Automate as a successful scrape.
   */
  protected buildResult(
    html: string,
    finalUrl: string,
    statusCode: number,
    engine: "static" | "playwright",
  ): EngineResult {
    const title = extractTitle(html);
    let content = extractText(html);
    content = this.postProcessContent(content, finalUrl);

    // Non-2xx responses are never successful regardless of content length.
    const isSuccessStatus = statusCode >= 200 && statusCode < 300;

    const meaningful =
      isSuccessStatus && isMeaningful(content, config.minMeaningfulChars);

    let error: string | undefined;
    if (!meaningful) {
      if (!isSuccessStatus) {
        error = `Target server returned HTTP ${statusCode}`;
      } else {
        error =
          "Extracted content was insufficient or indicated a blocked page";
      }
    }

    return {
      success: meaningful,
      finalUrl,
      scraperUsed: engine,
      title,
      content,
      statusCode,
      error,
    };
  }

  /** Structured log helper for scrape events. */
  protected log(
    requestId: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    logger.info({ requestId, ...data }, msg);
  }
}
