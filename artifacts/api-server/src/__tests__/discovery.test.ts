import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockedRender = vi.hoisted(() => vi.fn());
const mockedRecordRequest = vi.hoisted(() => vi.fn());

vi.mock("../scrapers/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scrapers/discovery.js")>();
  return { ...actual, renderDiscoveryLandingPage: mockedRender };
});

vi.mock("../lib/request-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/request-log.js")>();
  return { ...actual, recordScrapeRequest: mockedRecordRequest };
});

import discoveryRouter from "../routes/discovery.js";
import {
  collectDiscoveryArticles,
  resolveDiscoveryTarget,
} from "../scrapers/discovery.js";

const API_KEY = "discovery-test-key";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

function appForTest() {
  const app = express();
  app.use(express.json());
  app.use("/api", discoveryRouter);
  return app;
}

describe("discovery target period", () => {
  it("defaults January runs to the previous December and year", () => {
    expect(resolveDiscoveryTarget(undefined, undefined, new Date(2027, 0, 15))).toEqual({
      monthIndex: 11,
      month: "December",
      year: 2026,
    });
  });

  it("normalizes explicit month names and accepts a numeric year", () => {
    expect(resolveDiscoveryTarget("aug", 2026)).toEqual({
      monthIndex: 7,
      month: "August",
      year: 2026,
    });
  });

  it("rejects incomplete or malformed reporting periods", () => {
    expect(() => resolveDiscoveryTarget("August", undefined)).toThrow(/targetYear/i);
    expect(() => resolveDiscoveryTarget("NotAMonth", "2026")).toThrow(/targetMonth/i);
    expect(() => resolveDiscoveryTarget("August", "26")).toThrow(/four-digit/i);
  });
});

describe("discovery link collection", () => {
  const target = { monthIndex: 7, month: "August", year: 2026 };

  it("filters non-articles, deduplicates URLs, and matches visible dates", () => {
    const articles = collectDiscoveryArticles(
      [
        {
          href: "https://payer.example/news/provider-alert",
          title: "Provider alert",
          context: "Provider alert — August 12, 2026",
          sectionText: "",
        },
        {
          href: "https://payer.example/news/provider-alert",
          title: "Duplicate provider alert",
          context: "August 12, 2026",
          sectionText: "",
        },
        {
          href: "https://payer.example/archive/2026",
          title: "Archive",
          context: "August 2026",
          sectionText: "",
        },
        {
          href: "mailto:updates@payer.example",
          title: "Email us",
          context: "August 2026",
          sectionText: "",
        },
        {
          href: "https://payer.example/news/july-update",
          title: "July policy update",
          context: "July 2026",
          sectionText: "",
        },
        {
          href: "https://payer.example/files/august-bulletin.pdf",
          title: "August bulletin PDF",
          context: "2026-08-01",
          sectionText: "",
        },
      ],
      target,
    );

    expect(articles).toEqual([
      {
        title: "Provider alert",
        Date: "August 12, 2026",
        url: "https://payer.example/news/provider-alert",
      },
      {
        title: "August bulletin PDF",
        Date: "2026-08-01",
        url: "https://payer.example/files/august-bulletin.pdf",
      },
    ]);
  });

  it("includes undated entries inside a target-month section", () => {
    const articles = collectDiscoveryArticles(
      [
        {
          href: new URL("/updates/network-change", "https://payer.example").toString(),
          title: "Network update",
          context: "Network update details",
          sectionText: "August 2026",
        },
      ],
      target,
    );

    expect(articles).toEqual([
      {
        title: "Network update",
        Date: "August 2026",
        url: "https://payer.example/updates/network-change",
      },
    ]);
  });

  it("matches unpadded numeric table dates on PDF alert links", () => {
    const articles = collectDiscoveryArticles(
      [
        {
          href: "https://providers.bcidaho.com/resources/pdfs/providers/alerts/080126MPUpdts.pdf",
          title: "Medical Policy Updates",
          context: "8/1/2026 Medical Policy Updates All Providers",
          sectionText: "",
        },
        {
          href: "https://providers.bcidaho.com/resources/pdfs/providers/alerts/080126PAUpdts.pdf",
          title: "Prior Authorization (PA) List Updates",
          context: "8/1/2026 Prior Authorization (PA) List Updates All Providers",
          sectionText: "",
        },
      ],
      target,
    );

    expect(articles).toEqual([
      {
        title: "Medical Policy Updates",
        Date: "8/1/2026",
        url: "https://providers.bcidaho.com/resources/pdfs/providers/alerts/080126MPUpdts.pdf",
      },
      {
        title: "Prior Authorization (PA) List Updates",
        Date: "8/1/2026",
        url: "https://providers.bcidaho.com/resources/pdfs/providers/alerts/080126PAUpdts.pdf",
      },
    ]);
  });

  it("matches dates embedded in article and PDF destination paths", () => {
    const july = collectDiscoveryArticles(
      [
        {
          href: "https://www.bcbsil.com/news/2026/7-15-26-provider-update",
          title: "Read More",
          context: "Read More",
          sectionText: "",
        },
        {
          href: "https://www.bcbsil.com/news/2026/7-7-2026-policy-update",
          title: "Read More",
          context: "Read More",
          sectionText: "",
        },
        {
          href: "https://www.bcbsil.com/files/blue-review-20260701.pdf",
          title: "Read More",
          context: "Read More",
          sectionText: "",
        },
      ],
      { monthIndex: 6, month: "July", year: 2026 },
    );

    expect(july).toHaveLength(3);
    expect(july.map(({ Date }) => Date)).toEqual(["7-15-26", "7-7-2026", "20260701"]);
  });

  it("uses the issue month for a newsletter issue link without broadening filtering", () => {
    const august = collectDiscoveryArticles(
      [
        {
          href: "https://www.bcbsil.com/newsroom/blue-review",
          title: "Read More",
          context: "Read More",
          sectionText: "",
        },
        {
          href: "https://www.bcbsil.com/contact",
          title: "Read More",
          context: "Read More",
          sectionText: "",
        },
      ],
      target,
      "Blue Review August 2026",
    );

    expect(august).toEqual([
      {
        title: "Read More",
        Date: "August 2026",
        url: "https://www.bcbsil.com/newsroom/blue-review",
      },
    ]);
  });
});

describe("POST /api/scrape/discovery", () => {
  beforeEach(() => {
    process.env.PAYERNEWS_API_KEY = API_KEY;
    mockedRender.mockReset();
    mockedRecordRequest.mockReset();
    mockedRender.mockResolvedValue({
      finalUrl: "https://payer.example/updates",
      title: "Payer updates",
      payerName: "Example Payer",
      candidates: [
        {
          href: "https://payer.example/news/august-update",
          title: "August policy update",
          context: "Posted August 4, 2026",
          sectionText: "",
        },
      ],
    });
  });

  afterEach(() => {
    delete process.env.PAYERNEWS_API_KEY;
  });

  it("requires the existing bearer API key", async () => {
    const res = await request(appForTest())
      .post("/api/scrape/discovery")
      .send({ url: "https://payer.example/updates", targetMonth: "August", targetYear: "2026" });
    expect(res.status).toBe(401);
  });

  it("returns the specified discovery envelope and diagnostics", async () => {
    const res = await request(appForTest())
      .post("/api/scrape/discovery")
      .set(AUTH)
      .send({ url: "https://payer.example/updates", targetMonth: "August", targetYear: "2026" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      PayerName: "Example Payer",
      Landingpagetitle: "Payer updates",
      Targetmonth: "August",
      TargetYear: "2026",
      Articlecount: 1,
      Articles: [
        {
          title: "August policy update",
          Date: "August 4, 2026",
          url: "https://payer.example/news/august-update",
        },
      ],
      diagnostics: { linksFound: 1, linksMatched: 1, pageRendered: true, errors: [] },
    });
    expect(mockedRecordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "discovery",
        scraperUsed: "discovery",
        success: true,
        contentLength: 1,
      }),
    );
  });

  it("returns a JSON validation error for incomplete target periods", async () => {
    const res = await request(appForTest())
      .post("/api/scrape/discovery")
      .set(AUTH)
      .send({ url: "https://payer.example/updates", targetMonth: "August" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: expect.stringMatching(/targetYear/i) });
  });

  it("maps graceful navigation timeouts to JSON 504 responses", async () => {
    const { DiscoveryNavigationError } = await import("../scrapers/discovery.js");
    mockedRender.mockRejectedValueOnce(
      new DiscoveryNavigationError("Discovery navigation timed out", 504),
    );
    const res = await request(appForTest())
      .post("/api/scrape/discovery")
      .set(AUTH)
      .send({ url: "https://payer.example/updates", targetMonth: "August", targetYear: "2026" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ success: false, diagnostics: { pageRendered: false } });
    expect(mockedRecordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "discovery",
        scraperUsed: "discovery",
        success: false,
        httpStatus: 504,
        contentLength: 0,
      }),
    );
  });

  it("returns a concise 502 diagnostic when Chromium cannot launch", async () => {
    const { BrowserLaunchError } = await import("../scrapers/browser-pool.js");
    mockedRender.mockRejectedValueOnce(
      new BrowserLaunchError(
        "Browser automation could not start because Chromium is missing the runtime library libgbm.so.1.",
      ),
    );
    const res = await request(appForTest())
      .post("/api/scrape/discovery")
      .set(AUTH)
      .send({ url: "https://payer.example/updates", targetMonth: "August", targetYear: "2026" });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      error: "Browser automation could not start because Chromium is missing the runtime library libgbm.so.1.",
      diagnostics: { pageRendered: false },
    });
  });
});