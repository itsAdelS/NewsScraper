/**
 * Static HTTP scraper — fast first-pass using our SSRF-safe HTTP client
 * and cheerio.
 *
 * Uses `safeFetch` from `../utils/safe-fetch.ts` which is built on
 * `node:http` / `node:https` with a custom `lookup` function.  The same
 * function that validates the resolved IP is passed to the underlying TCP
 * socket, eliminating the DNS-rebinding TOCTOU gap that would exist if we
 * first validated and then reconnected via the OS resolver.
 */

import { BaseScraper, safeFetch } from "./base.js";
import { UrlValidationError } from "../utils/validation.js";
import type { EngineResult } from "./types.js";

export class StaticScraper extends BaseScraper {
  async scrape(url: string, requestId: string): Promise<EngineResult> {
    this.log(requestId, "Static scraper: starting request", { url });

    let page;
    try {
      page = await safeFetch(url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode =
        err instanceof UrlValidationError
          ? err.httpStatus === 403 ? 403 : 400
          : 0;

      this.log(requestId, "Static scraper: fetch failed", {
        error: message,
        statusCode,
      });

      return {
        success: false,
        finalUrl: "",
        scraperUsed: "static",
        title: "",
        content: "",
        statusCode,
        error: message,
      };
    }

    this.log(requestId, "Static scraper: fetch complete", {
      statusCode: page.statusCode,
      finalUrl: page.finalUrl,
      bodyLength: page.html.length,
      truncatedBody: page.truncatedBody,
    });

    const result = this.buildResult(
      page.html,
      page.finalUrl,
      page.statusCode,
      "static",
    );

    this.log(requestId, "Static scraper: extraction complete", {
      success: result.success,
      contentLength: result.content.length,
    });

    return result;
  }
}
