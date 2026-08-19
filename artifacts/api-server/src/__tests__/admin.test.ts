/**
 * Admin console security tests:
 *  - Session-required pages and JSON APIs (401 without auth)
 *  - Login success/failure, brute-force lockout (429 even with correct password)
 *  - CSRF enforcement on controls and logout
 *  - Pause gate: POST /api/scrape returns the exact 503 body + Retry-After,
 *    and the normal scrape contract is unchanged after resume
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

const API_KEY = "test-admin-suite-key";
const PASSWORD = "correct-horse-battery";

// Env must be set BEFORE the app (and its modules) are imported.
process.env.PAYERNEWS_API_KEY = API_KEY;
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: test only
process.env.SESSION_SECRET = "test-session-secret";

// Mock the scraper registry so no real scraping happens.
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

// Avoid touching a real database from these tests.
vi.mock("../lib/request-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/request-log.js")>();
  return {
    ...actual,
    recordScrapeRequest: vi.fn(),
    queryRequests: vi
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageCount: 1, limit: 25 }),
    getScrapeStats: vi.fn().mockResolvedValue({}),
    getRequestByRequestId: vi.fn().mockResolvedValue(undefined),
    getActivityBuckets: vi.fn().mockResolvedValue([]),
  };
});

const { default: app } = await import("../app.js");
const { setOpsMode } = await import("../lib/ops-state.js");

afterAll(() => {
  setOpsMode("normal", "test-cleanup");
  delete process.env.PAYERNEWS_API_KEY;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.SESSION_SECRET;
});

/** Log in and return the session cookie + CSRF token. */
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post("/admin/login")
    .type("form")
    .send({ username: "admin", password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
  expect(cookie).toContain("pn_admin_session=");
  const me = await request(app).get("/api/admin/me").set("Cookie", cookie!);
  expect(me.status).toBe(200);
  return { cookie: cookie!, csrf: me.body.csrfToken as string };
}

describe("admin auth boundary", () => {
  it("rejects admin pages without a session", async () => {
    for (const path of ["/admin/", "/admin/requests", "/admin/controls"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    }
  });

  it("rejects admin JSON APIs without auth", async () => {
    const res = await request(app).get("/api/admin/status");
    expect(res.status).toBe(401);
  });

  it("does NOT accept the API bearer key for admin-only endpoints", async () => {
    for (const path of ["/api/admin/me", "/api/admin/requests", "/api/admin/stats"]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(401);
    }
  });

  it("allows the API bearer key for status/alerts polling only", async () => {
    const res = await request(app)
      .get("/api/admin/status")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBeDefined();
  });

  it("still returns the documented 400 for malformed scrape URLs (logging must not break it)", async () => {
    for (const url of ["http://", "https://user:password@", "not a url"]) {
      const res = await request(app)
        .post("/api/scrape")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url });
      expect([400, 403]).toContain(res.status);
      expect(res.body.success).toBe(false);
    }
  });

  it("rejects a wrong password with a generic 401", async () => {
    const res = await request(app)
      .post("/admin/login")
      .type("form")
      .send({ username: "admin", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.text).toContain("Invalid username or password");
  });
});

describe("session + CSRF + controls + pause gate", () => {
  it("full flow: login → controls need CSRF → pause gates /api/scrape → resume → logout", async () => {
    const { cookie, csrf } = await login();

    // Authenticated page works.
    expect((await request(app).get("/admin/").set("Cookie", cookie)).status).toBe(200);

    // Controls without CSRF are rejected.
    const noCsrf = await request(app)
      .post("/api/admin/controls/pause")
      .set("Cookie", cookie);
    expect(noCsrf.status).toBe(403);

    // Pause with CSRF.
    const pause = await request(app)
      .post("/api/admin/controls/pause")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf);
    expect(pause.status).toBe(200);
    expect(pause.body.mode).toBe("paused");

    // Scrape is gated with the exact spec body.
    const gated = await request(app)
      .post("/api/scrape")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ url: "https://example.com" });
    expect(gated.status).toBe(503);
    expect(gated.headers["retry-after"]).toBeDefined();
    expect(gated.body).toMatchObject({
      success: false,
      status: "paused",
      retryAfterSeconds: expect.any(Number),
    });
    expect(typeof gated.body.error).toBe("string");

    // Resume — scrape contract unchanged.
    const resume = await request(app)
      .post("/api/admin/controls/resume")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf);
    expect(resume.status).toBe(200);

    const ok = await request(app)
      .post("/api/scrape")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ url: "https://example.com" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      success: true,
      url: "https://example.com",
      route: "generic",
      scraperUsed: "static",
    });
    expect(ok.body.content).toBeDefined();
    expect(ok.body.durationMs).toBeDefined();

    // Logout requires CSRF too.
    expect(
      (await request(app).post("/admin/logout").set("Cookie", cookie)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/admin/logout")
          .set("Cookie", cookie)
          .set("x-csrf-token", csrf)
      ).status,
    ).toBe(200);
    expect((await request(app).get("/admin/").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("activity endpoint", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/admin/activity");
    expect(res.status).toBe(401);
  });

  it("accepts API bearer key (same as /status)", async () => {
    const res = await request(app)
      .get("/api/admin/activity")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(typeof res.body.bucketSecs).toBe("number");
    expect(typeof res.body.generatedAt).toBe("string");
  });

  it("returns correct bucket shape with session auth", async () => {
    const { cookie } = await login();
    const res = await request(app)
      .get("/api/admin/activity?minutes=5&bucketSecs=60")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    // getActivityBuckets is mocked to return [] — shape/auth is what matters here
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.bucketSecs).toBe(60);
  });

  it("returns PDF activity counts in the activity response", async () => {
    const { getActivityBuckets } = await import("../lib/request-log.js");
    vi.mocked(getActivityBuckets).mockResolvedValueOnce([
      { ts: 100, static: 2, playwright: 1, pdf: 3 },
    ]);
    const res = await request(app)
      .get("/api/admin/activity")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.buckets[0]).toEqual({ ts: 100, static: 2, playwright: 1, pdf: 3 });
  });

  it("includes PDF presentation labels in the admin console", async () => {
    const { cookie } = await login();
    const res = await request(app).get("/admin/").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain(">PDF</span>");
    expect(res.text).toContain("background:#f85149");
  });

  it("degrades gracefully and returns 200 with empty buckets when getActivityBuckets throws", async () => {
    const { getActivityBuckets } = await import("../lib/request-log.js");
    vi.mocked(getActivityBuckets).mockRejectedValueOnce(new Error("DB connection lost"));
    const res = await request(app)
      .get("/api/admin/activity")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.buckets).toHaveLength(0);
  });
});

describe("brute-force lockout (runs last — poisons the shared IP)", () => {
  it("locks out after repeated failures, even with the correct password", async () => {
    // Successful login earlier cleared the counter; record 5 fresh failures.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/admin/login")
        .type("form")
        .send({ username: "admin", password: `bad-${i}` });
      expect(res.status).toBe(401);
    }
    const locked = await request(app)
      .post("/admin/login")
      .type("form")
      .send({ username: "admin", password: "bad-final" });
    expect(locked.status).toBe(429);

    const correctButLocked = await request(app)
      .post("/admin/login")
      .type("form")
      .send({ username: "admin", password: PASSWORD });
    expect(correctButLocked.status).toBe(429);
  });
});
