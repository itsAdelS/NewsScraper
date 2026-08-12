/**
 * Tests for Express app-level concerns:
 *  - Malformed JSON bodies always return JSON (never HTML)
 *  - The "always JSON" contract holds for unhandled errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../app.js";

// We need a real API key to get past auth and reach the JSON-parse error
// (the auth middleware runs first; if auth fails the JSON parse error
// never fires and the test would be misleading).
const KEY = "test-app-key";

beforeEach(() => {
  process.env.PAYERNEWS_API_KEY = KEY;
});

afterEach(() => {
  delete process.env.PAYERNEWS_API_KEY;
});

// Mock the scraper registry so the route doesn't try real scraping.
vi.mock("../scrapers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scrapers/registry.js")>();
  return {
    ...actual,
    getScraper: vi.fn().mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: true,
        finalUrl: "https://example.com/policy",
        scraperUsed: "static",
        title: "Test",
        content: "Policy text ".repeat(30),
        statusCode: 200,
      }),
    }),
  };
});

// Mock DNS so SSRF validation passes
vi.mock("node:dns/promises", () => ({
  lookup: vi
    .fn()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

describe("JSON body-parser error handler", () => {
  it("returns JSON (not HTML) for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/scrape")
      .set("Authorization", `Bearer ${KEY}`)
      .set("Content-Type", "application/json")
      .send("{ this is not valid JSON }");

    // Must always return JSON
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toContain("Invalid JSON");
  });

  it("returns JSON for an empty body with content-type application/json", async () => {
    const res = await request(app)
      .post("/api/scrape")
      .set("Authorization", `Bearer ${KEY}`)
      .set("Content-Type", "application/json")
      .send("");

    // Empty body is allowed by JSON parser (treated as no body)
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
