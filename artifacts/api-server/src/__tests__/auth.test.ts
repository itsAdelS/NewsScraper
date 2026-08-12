/**
 * Authentication middleware tests.
 *
 * Test cases 4 & 5:
 *  4. Missing API key → 401
 *  5. Invalid API key → 401
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { requireApiKey } from "../middleware/auth.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/test", requireApiKey, (_req, res) => {
    res.status(200).json({ success: true });
  });
  return app;
}

describe("requireApiKey middleware", () => {
  const originalKey = process.env.PAYERNEWS_API_KEY;

  beforeEach(() => {
    process.env.PAYERNEWS_API_KEY = "test-secret-key-12345";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.PAYERNEWS_API_KEY;
    } else {
      process.env.PAYERNEWS_API_KEY = originalKey;
    }
  });

  // Test case 4: Missing API key
  it("returns 401 when Authorization header is absent", async () => {
    const app = buildApp();
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toContain("Missing");
  });

  it("returns 401 when Authorization header has no Bearer prefix", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({});
    expect(res.status).toBe(401);
  });

  // Test case 5: Invalid API key
  it("returns 401 for an incorrect API key", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .set("Authorization", "Bearer wrong-key")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: "Invalid API key" });
  });

  it("returns 200 for a correct API key", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .set("Authorization", "Bearer test-secret-key-12345")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 401 when PAYERNEWS_API_KEY is not configured", async () => {
    delete process.env.PAYERNEWS_API_KEY;
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .set("Authorization", "Bearer anything")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("not configured");
  });
});
