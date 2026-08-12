/**
 * Tests for BaseScraper.buildResult — focusing on the non-2xx success rules
 * and content-quality heuristics.
 *
 * A non-2xx page must always be success:false even if it contains
 * readable content that would otherwise pass the meaningfulness check.
 */

import { describe, it, expect } from "vitest";
import { BaseScraper } from "../scrapers/base.js";
import type { EngineResult } from "../scrapers/types.js";

// Expose the protected buildResult for unit testing via a thin subclass.
class TestScraper extends BaseScraper {
  async scrape(): Promise<EngineResult> {
    throw new Error("not used in unit tests");
  }

  public callBuildResult(
    html: string,
    finalUrl: string,
    statusCode: number,
    engine: "static" | "playwright",
  ): EngineResult {
    return this.buildResult(html, finalUrl, statusCode, engine);
  }
}

// Enough content to pass the minimum-chars heuristic.
const GOOD_HTML = `
  <html><body>
    <h1>Medical Policy Update</h1>
    ${"<p>Prior authorization is required for the following procedures.</p>".repeat(10)}
  </body></html>
`;

// Short enough to fail the minimum-chars check on its own.
const EMPTY_HTML = "<html><body><p>Hi</p></body></html>";

const scraper = new TestScraper();
const URL = "https://example.com/policy";

describe("BaseScraper.buildResult — HTTP status rules", () => {
  it("marks 200 + meaningful content as success:true", () => {
    const result = scraper.callBuildResult(GOOD_HTML, URL, 200, "static");
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.scraperUsed).toBe("static");
    expect(result.error).toBeUndefined();
  });

  it("marks 404 + meaningful content as success:false (not found is a failure)", () => {
    const result = scraper.callBuildResult(GOOD_HTML, URL, 404, "static");
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toContain("404");
    // Content is still returned so the caller can inspect it.
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("marks 403 + meaningful content as success:false", () => {
    const result = scraper.callBuildResult(GOOD_HTML, URL, 403, "playwright");
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toContain("403");
  });

  it("marks 500 + meaningful content as success:false", () => {
    const result = scraper.callBuildResult(GOOD_HTML, URL, 500, "static");
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("marks 301 as success:false (redirect without following is a failure)", () => {
    const result = scraper.callBuildResult(GOOD_HTML, URL, 301, "static");
    expect(result.success).toBe(false);
  });

  it("marks 200 + insufficient content as success:false", () => {
    const result = scraper.callBuildResult(EMPTY_HTML, URL, 200, "static");
    expect(result.success).toBe(false);
    expect(result.error).toContain("insufficient");
  });

  it("extracts the page title even on non-2xx pages", () => {
    const html = `
      <html>
        <head><title>404 Not Found</title></head>
        <body><p>The page you requested could not be found.</p></body>
      </html>
    `;
    const result = scraper.callBuildResult(html, URL, 404, "static");
    expect(result.title).toBe("404 Not Found");
    expect(result.success).toBe(false);
  });
});
