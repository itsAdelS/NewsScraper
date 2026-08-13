/**
 * Integration tests for POST /api/scrape.
 *
 * All 15 test cases from the spec are covered here or in the other test files:
 *  1. Missing URL → 400
 *  2. Invalid URL → 400 (also validation.test.ts)
 *  3. Unsupported URL scheme → 400 (also validation.test.ts)
 *  4. Missing API key → 401 (auth.test.ts)
 *  5. Invalid API key → 401 (auth.test.ts)
 *  6. Valid public HTML page → 200, success: true
 *  7. Redirected page → 200, finalUrl !== url
 *  8. Empty page → 422
 *  9. 404 response → recorded statusCode
 * 10. Static scrape success → scraperUsed: "static"
 * 11. Static failure + Playwright fallback → scraperUsed: "playwright"
 * 12. Both scrapers failing → 422
 * 13. localhost SSRF attempt → 400/403 (also validation.test.ts)
 * 14. Private IP SSRF attempt → 403 (also validation.test.ts)
 * 15. Domain-based route selection (validation.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import type { ScrapeResponseBody } from "../scrapers/types.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock DNS resolution so tests don't make real DNS calls.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

// Mock the scraper registry so we control what each scraper returns.
vi.mock("../scrapers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scrapers/registry.js")>();
  return {
    ...actual,
    getScraper: vi.fn(),
  };
});

import { getScraper } from "../scrapers/registry.js";
const mockGetScraper = vi.mocked(getScraper);

// ─── App factory ─────────────────────────────────────────────────────────────

async function buildApp() {
  // We import the router AFTER mocks are set up.
  const { default: app } = await import("../../src/app.js");
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_API_KEY = "scraper-test-key";
const AUTH = { Authorization: `Bearer ${VALID_API_KEY}` };

function makeScraper(
  overrides: Partial<{
    success: boolean;
    finalUrl: string;
    scraperUsed: "static" | "playwright" | "";
    title: string;
    content: string;
    statusCode: number;
    error: string;
  }> = {},
) {
  return {
    scrape: vi.fn().mockResolvedValue({
      success: true,
      finalUrl: "https://example.com/policy",
      scraperUsed: "static",
      title: "Sample Policy",
      content: "A ".repeat(200), // 400 chars — above minMeaningfulChars
      statusCode: 200,
      ...overrides,
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/scrape", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PAYERNEWS_API_KEY = VALID_API_KEY;
    // Build a fresh app for each test (module cache is isolated by vitest).
    app = express();
    app.use(express.json());

    // Re-import routes with mocks in place.
    const healthRouter = (await import("../routes/health.js")).default;
    const scrapeRouter = (await import("../routes/scrape.js")).default;
    app.use("/api", healthRouter);
    app.use("/api", scrapeRouter);
  });

  afterEach(() => {
    delete process.env.PAYERNEWS_API_KEY;
  });

  // ── Test case 1: Missing URL ──────────────────────────────────────────────

  it("1. returns 400 when url field is missing", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ route: "generic" });

    expect(res.status).toBe(400);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(false);
    expect(body.error).toContain("url");
  });

  // ── Test case 2: Invalid URL ──────────────────────────────────────────────

  it("2. returns 400 for a non-parseable URL", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "this is not a url" });

    expect(res.status).toBe(400);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  // ── Test case 3: Unsupported URL scheme ───────────────────────────────────

  it("3. returns 400 for a file:// URL", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "file:///etc/passwd" });

    expect(res.status).toBe(400);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  // ── Test case 6: Valid public HTML page ───────────────────────────────────

  it("6. returns 200 with success:true for a valid public page", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/policy" });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(true);
    expect(body.url).toBe("https://example.com/policy");
    expect(body.contentLength).toBeGreaterThan(0);
    expect(body.truncated).toBe(false);
    expect(body.durationMs).toBeTypeOf("number");
  });

  // ── Test case 7: Redirected page ─────────────────────────────────────────

  it("7. records the final URL after a redirect", async () => {
    const REDIRECTED_URL = "https://example.com/redirected-policy";
    mockGetScraper.mockReturnValue(
      makeScraper({ finalUrl: REDIRECTED_URL }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/original" });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.finalUrl).toBe(REDIRECTED_URL);
    expect(body.url).toBe("https://example.com/original");
  });

  // ── Test case 8: Empty page ───────────────────────────────────────────────

  it("8. returns 422 when content is empty/insufficient", async () => {
    mockGetScraper.mockReturnValue(
      makeScraper({
        success: false,
        content: "",
        scraperUsed: "",
        error: "Extracted content was insufficient",
      }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/empty" });

    expect(res.status).toBe(422);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(false);
  });

  // ── Test case 9: 404 response ─────────────────────────────────────────────

  it("9. records 404 statusCode in the response", async () => {
    mockGetScraper.mockReturnValue(
      makeScraper({
        success: false,
        statusCode: 404,
        content: "",
        error: "Page not found",
      }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/missing-page" });

    const body = res.body as ScrapeResponseBody;
    expect(body.statusCode).toBe(404);
    expect(body.success).toBe(false);
  });

  // ── Test case 10: Static scrape success ──────────────────────────────────

  it("10. reports scraperUsed:'static' when static scraper succeeds", async () => {
    mockGetScraper.mockReturnValue(
      makeScraper({ scraperUsed: "static" }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/policy" });

    expect(res.status).toBe(200);
    expect((res.body as ScrapeResponseBody).scraperUsed).toBe("static");
  });

  // ── Test case 11: Static failure + Playwright fallback ───────────────────

  it("11. reports scraperUsed:'playwright' after fallback", async () => {
    mockGetScraper.mockReturnValue(
      makeScraper({ scraperUsed: "playwright" }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/js-heavy" });

    expect(res.status).toBe(200);
    expect((res.body as ScrapeResponseBody).scraperUsed).toBe("playwright");
  });

  // ── Test case 12: Both scrapers failing ──────────────────────────────────

  it("12. returns 422 when both scrapers fail", async () => {
    mockGetScraper.mockReturnValue(
      makeScraper({
        success: false,
        scraperUsed: "playwright",
        content: "",
        error: "Both static and browser scrapers failed",
      }),
    );
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/blocked" });

    expect(res.status).toBe(422);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  // ── Test case 13: localhost SSRF ─────────────────────────────────────────

  it("13. rejects localhost SSRF attempt with 4xx", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "http://localhost:8080/admin" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  // ── Test case 14: Private IP SSRF ────────────────────────────────────────

  it("14. rejects private IP SSRF attempt", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "http://10.0.0.1/internal" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  // ── Response shape validation ─────────────────────────────────────────────

  it("always returns JSON even on failure", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "not-a-url" });

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toBeTypeOf("object");
  });

  it("response body contains all required fields on success", async () => {
    mockGetScraper.mockReturnValue(makeScraper());
    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: "https://example.com/policy" });

    const body = res.body as ScrapeResponseBody;
    expect(body).toHaveProperty("success");
    expect(body).toHaveProperty("url");
    expect(body).toHaveProperty("finalUrl");
    expect(body).toHaveProperty("route");
    expect(body).toHaveProperty("scraperUsed");
    expect(body).toHaveProperty("title");
    expect(body).toHaveProperty("content");
    expect(body).toHaveProperty("contentLength");
    expect(body).toHaveProperty("statusCode");
    expect(body).toHaveProperty("durationMs");
    expect(body).toHaveProperty("truncated");
  });

  it("GET /api/health returns service identity and browser pool stats", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "healthy",
      service: "PayerNews Scraper",
    });
    expect(res.body.browserPool).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
      browserRunning: expect.any(Boolean),
      maxContexts: expect.any(Number),
      maxQueue: expect.any(Number),
    });
  });
});
