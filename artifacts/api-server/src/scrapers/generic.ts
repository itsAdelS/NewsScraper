/**
 * GenericScraper — the default scraper.
 *
 * Strategy:
 *  1. Try the static (HTTP + cheerio) scraper.
 *  2. If content is insufficient, fall back to the Playwright browser scraper.
 *  3. If both fail, return a structured failure.
 */

import { BaseScraper } from "./base.js";
import { StaticScraper } from "./static-scraper.js";
import { BrowserScraper } from "./browser-scraper.js";
import type { EngineResult } from "./types.js";

export class GenericScraper extends BaseScraper {
  private readonly static = new StaticScraper();
  private readonly browser = new BrowserScraper();

  async scrape(url: string, requestId: string): Promise<EngineResult> {
    // --- Attempt 1: static scraper ---
    this.log(requestId, "Generic scraper: trying static engine");
    const staticResult = await this.static.scrape(url, requestId);

    if (staticResult.success) {
      this.log(requestId, "Generic scraper: static engine succeeded", {
        contentLength: staticResult.content.length,
      });
      return staticResult;
    }

    this.log(requestId, "Generic scraper: static engine insufficient, falling back to Playwright", {
      staticContentLength: staticResult.content.length,
    });

    // --- Attempt 2: browser scraper ---
    const browserResult = await this.browser.scrape(url, requestId);

    if (browserResult.success) {
      this.log(requestId, "Generic scraper: Playwright engine succeeded", {
        contentLength: browserResult.content.length,
      });
      return browserResult;
    }

    this.log(requestId, "Generic scraper: both engines failed", {
      staticError: staticResult.error,
      browserError: browserResult.error,
    });

    // Both failed — return the browser result (it tried harder).
    return {
      ...browserResult,
      error: browserResult.error ?? staticResult.error ?? "Both static and browser scrapers failed to extract meaningful content",
    };
  }
}
