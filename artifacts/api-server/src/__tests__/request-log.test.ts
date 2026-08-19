/**
 * Redaction tests for the persistent request history: URLs and error text
 * are sanitized before storage so credentials, tokens, and signed-URL
 * parameters are never retained.
 */

import { describe, it, expect } from "vitest";
import { sanitizeUrlForLog, sanitizeText } from "../lib/request-log.js";

describe("sanitizeUrlForLog", () => {
  it("strips userinfo credentials", () => {
    expect(sanitizeUrlForLog("https://user:hunter2@example.com/page")).toBe(
      "https://example.com/page",
    );
  });

  it("redacts sensitive query parameters", () => {
    const out = sanitizeUrlForLog(
      "https://example.com/doc?api_key=abc123&access_token=xyz&page=2&X-Amz-Signature=deadbeef",
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("page=2");
    expect(out).toContain("api_key=REDACTED");
  });

  it("leaves benign URLs unchanged", () => {
    expect(sanitizeUrlForLog("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
  });

  it("handles unparseable input without throwing", () => {
    expect(sanitizeUrlForLog("not a url")).toBe("not a url");
    expect(sanitizeUrlForLog("")).toBe("");
  });

  it("strips URL fragments (OAuth implicit-flow credentials)", () => {
    expect(
      sanitizeUrlForLog("https://example.com/callback#access_token=secret&state=x"),
    ).toBe("https://example.com/callback");
    expect(sanitizeText("redirected to https://example.com/cb#token=abc then failed")).toBe(
      "redirected to https://example.com/cb then failed",
    );
  });

  it("fails closed on malformed HTTP-like strings without recursing", () => {
    expect(sanitizeUrlForLog("https://user:password@")).toBe("REDACTED-UNPARSEABLE-URL");
    expect(sanitizeUrlForLog("http://")).toBe("REDACTED-UNPARSEABLE-URL");
    expect(sanitizeText("failed for http://user:pw@ twice")).toContain("REDACTED-UNPARSEABLE-URL");
  });
});

describe("getActivityBuckets (no DATABASE_URL → zero series from fallback)", () => {
  it("always includes the current aligned bucket as the last entry", async () => {
    const { getActivityBuckets } = await import("../lib/request-log.js");
    const bucketSecs = 30;
    const before = Math.floor(Date.now() / 1000 / bucketSecs) * bucketSecs;
    const buckets = await getActivityBuckets(10, bucketSecs);
    const after = Math.floor(Date.now() / 1000 / bucketSecs) * bucketSecs;
    // Last bucket must be the current aligned slot (may advance if we straddle a boundary)
    expect(buckets[buckets.length - 1].ts).toBeGreaterThanOrEqual(before);
    expect(buckets[buckets.length - 1].ts).toBeLessThanOrEqual(after);
  });

  it("returns exactly minutes*60/bucketSecs entries", async () => {
    const { getActivityBuckets } = await import("../lib/request-log.js");
    const buckets = await getActivityBuckets(10, 30);
    expect(buckets.length).toBe(20);
    const buckets2 = await getActivityBuckets(5, 60);
    expect(buckets2.length).toBe(5);
  });

  it("buckets are sorted ascending with non-negative integer counts", async () => {
    const { getActivityBuckets } = await import("../lib/request-log.js");
    const buckets = await getActivityBuckets(10, 30);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].ts).toBeGreaterThan(buckets[i - 1].ts);
    }
    for (const b of buckets) {
      expect(Number.isInteger(b.static)).toBe(true);
      expect(Number.isInteger(b.playwright)).toBe(true);
      expect(Number.isInteger(b.pdf)).toBe(true);
      expect(b.static).toBeGreaterThanOrEqual(0);
      expect(b.playwright).toBeGreaterThanOrEqual(0);
      expect(b.pdf).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("sanitizeText", () => {
  it("redacts URLs embedded in error messages", () => {
    const out = sanitizeText(
      "Fetch failed for https://u:pw@example.com/x?token=s3cret after 3 retries",
    );
    expect(out).not.toContain("pw@");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("after 3 retries");
  });
});
