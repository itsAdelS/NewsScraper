/**
 * Tests for the PDF scraping pipeline.
 *
 * Covers:
 *  - PDF detection helpers (magic bytes, Content-Type, URL extension, HTML-from-.pdf)
 *  - Successful native extraction metadata
 *  - Mixed (native + OCR) extraction metadata
 *  - Fully OCR'd ("scanned") PDF metadata
 *  - Size limit rejection
 *  - Page limit rejection
 *  - Encrypted PDF rejection
 *  - Corrupt/unopenable PDF rejection
 *  - Worker / process failure
 *  - OCR timeout (PdfTimeoutError)
 *  - PDF pool full (PdfPoolFullError)
 *  - Route-level 503/504/422 mapping
 *  - documentType field in response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock DNS so no real network calls happen.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

// Mock the scraper registry (HTML path).
vi.mock("../scrapers/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scrapers/registry.js")>();
  return { ...actual, getScraper: vi.fn() };
});

// Mock safeFetchBinary — controls what the route "downloads".
vi.mock("../utils/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/safe-fetch.js")>();
  return { ...actual, safeFetchBinary: vi.fn() };
});

// Mock scrapePdf — controls PDF extraction results.
vi.mock("../scrapers/pdf-scraper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scrapers/pdf-scraper.js")>();
  return { ...actual, scrapePdf: vi.fn() };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { getScraper } from "../scrapers/registry.js";
import { safeFetchBinary } from "../utils/safe-fetch.js";
import { scrapePdf, detectPdf, hasPdfMagic, isPdfContentType, hasPdfExtension } from "../scrapers/pdf-scraper.js";
import {
  PdfPoolFullError,
  PdfTimeoutError,
  PdfPool,
  pdfPool,
} from "../scrapers/pdf-pool.js";
import type { ScrapeResponseBody } from "../scrapers/types.js";

const mockGetScraper = vi.mocked(getScraper);
const mockSafeFetchBinary = vi.mocked(safeFetchBinary);
const mockScrapePdf = vi.mocked(scrapePdf);

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_API_KEY = "scraper-test-key";
const AUTH = { Authorization: `Bearer ${VALID_API_KEY}` };
const PDF_URL = "https://example.com/document.pdf";
const HTML_URL = "https://example.com/page";

/** Minimal valid PDF magic bytes header. */
const PDF_MAGIC_BUF = Buffer.from("%PDF-1.4\n%%EOF", "ascii");

/** Successful HTML scraper mock. */
function makeHtmlScraper() {
  return {
    scrape: vi.fn().mockResolvedValue({
      success: true,
      finalUrl: HTML_URL,
      scraperUsed: "static",
      title: "Sample Page",
      content: "A ".repeat(200),
      statusCode: 200,
    }),
  };
}

/** A safeFetchBinary response that looks like HTML. */
function htmlPeek(url = HTML_URL) {
  return Promise.resolve({
    body: Buffer.from("<html><body>hello</body></html>"),
    finalUrl: url,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    truncatedBody: false,
  });
}

/** A safeFetchBinary response that looks like a PDF (magic bytes). */
function pdfPeek(url = PDF_URL, opts: { contentType?: string; truncated?: boolean; statusCode?: number } = {}) {
  return Promise.resolve({
    body: PDF_MAGIC_BUF,
    finalUrl: url,
    statusCode: opts.statusCode ?? 200,
    contentType: opts.contentType ?? "application/pdf",
    truncatedBody: opts.truncated ?? false,
  });
}

/** Successful PDF extraction result. */
function pdfResult(overrides: Partial<Awaited<ReturnType<typeof scrapePdf>>> = {}) {
  return {
    success: true,
    finalUrl: PDF_URL,
    scraperUsed: "pdf-native" as const,
    title: "Test Document",
    content: "Page one content. ".repeat(50),
    statusCode: 200,
    ocrUsed: false,
    pageCount: 5,
    nativePages: 5,
    ocrPages: 0,
    pdfSizeBytes: 12345,
    ...overrides,
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const healthRouter = (await import("../routes/health.js")).default;
  const scrapeRouter = (await import("../routes/scrape.js")).default;
  app.use("/api", healthRouter);
  app.use("/api", scrapeRouter);
  return app;
}

// ── Detection unit tests ─────────────────────────────────────────────────────

describe("PDF detection helpers", () => {
  it("hasPdfMagic returns true for %PDF- prefix", () => {
    expect(hasPdfMagic(Buffer.from("%PDF-1.4 content", "ascii"))).toBe(true);
  });

  it("hasPdfMagic returns false for HTML content", () => {
    expect(hasPdfMagic(Buffer.from("<html>...</html>"))).toBe(false);
  });

  it("hasPdfMagic returns false for short buffer", () => {
    expect(hasPdfMagic(Buffer.from("%PDF"))).toBe(false);
  });

  it("isPdfContentType returns true for application/pdf", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
  });

  it("isPdfContentType returns true for application/pdf; charset=binary", () => {
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
  });

  it("isPdfContentType returns true for application/x-pdf", () => {
    expect(isPdfContentType("application/x-pdf")).toBe(true);
  });

  it("isPdfContentType returns false for text/html", () => {
    expect(isPdfContentType("text/html")).toBe(false);
  });

  it("isPdfContentType returns false for undefined", () => {
    expect(isPdfContentType(undefined)).toBe(false);
  });

  it("hasPdfExtension returns true for .pdf URL", () => {
    expect(hasPdfExtension("https://example.com/doc.pdf")).toBe(true);
  });

  it("hasPdfExtension returns true for .PDF (uppercase)", () => {
    expect(hasPdfExtension("https://example.com/doc.PDF")).toBe(true);
  });

  it("hasPdfExtension returns false for .html URL", () => {
    expect(hasPdfExtension("https://example.com/page.html")).toBe(false);
  });

  it("detectPdf: magic bytes → PDF regardless of content-type", () => {
    expect(detectPdf(PDF_MAGIC_BUF, "text/html", "https://example.com/foo")).toBe(true);
  });

  it("detectPdf: application/pdf content-type → PDF (no magic bytes)", () => {
    const buf = Buffer.from("not a pdf");
    expect(detectPdf(buf, "application/pdf", "https://example.com/foo")).toBe(true);
  });

  it("detectPdf: HTML body from .pdf URL → NOT PDF (follows HTML path)", () => {
    const htmlBody = Buffer.from("<!DOCTYPE html><html></html>");
    expect(detectPdf(htmlBody, "text/html", "https://example.com/doc.pdf")).toBe(false);
  });

  it("detectPdf: empty content-type and no magic → not PDF", () => {
    const htmlBody = Buffer.from("<html></html>");
    expect(detectPdf(htmlBody, undefined, "https://example.com/page")).toBe(false);
  });
});

// ── Route-level integration tests ─────────────────────────────────────────────

describe("POST /api/scrape — PDF pipeline", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PAYERNEWS_API_KEY = VALID_API_KEY;
    mockGetScraper.mockReturnValue(makeHtmlScraper());
    app = await buildApp();
  });

  afterEach(() => {
    delete process.env.PAYERNEWS_API_KEY;
  });

  // ── Detection routing ───────────────────────────────────────────────────────

  it("routes to PDF pipeline when magic bytes detected", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue(pdfResult());

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.documentType).toBe("pdf");
    expect(body.success).toBe(true);
    expect(mockScrapePdf).toHaveBeenCalledWith(
      PDF_URL,
      expect.any(String),
      expect.objectContaining({ finalUrl: PDF_URL }),
    );
  });

  it("routes HTML to HTML pipeline (documentType: html)", async () => {
    mockSafeFetchBinary.mockResolvedValue(htmlPeek() as any);

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: HTML_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.documentType).toBe("html");
    expect(mockScrapePdf).not.toHaveBeenCalled();
  });

  it("reuses the classification fetch in the existing HTML scraper", async () => {
    mockSafeFetchBinary.mockResolvedValue(htmlPeek() as any);
    const htmlScraper = makeHtmlScraper();
    mockGetScraper.mockReturnValue(htmlScraper);

    await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: HTML_URL });

    expect(mockSafeFetchBinary).toHaveBeenCalledTimes(1);
    expect(htmlScraper.scrape).toHaveBeenCalledWith(
      HTML_URL,
      expect.any(String),
      expect.objectContaining({
        html: "<html><body>hello</body></html>",
        finalUrl: HTML_URL,
        statusCode: 200,
      }),
    );
  });

  it("routes .pdf URL returning HTML to HTML pipeline", async () => {
    // .pdf extension but body is HTML → HTML path
    mockSafeFetchBinary.mockResolvedValue({
      body: Buffer.from("<!DOCTYPE html><html><body>content</body></html>"),
      finalUrl: PDF_URL,
      statusCode: 200,
      contentType: "text/html",
      truncatedBody: false,
    } as any);

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    const body = res.body as ScrapeResponseBody;
    expect(body.documentType).toBe("html");
    expect(mockScrapePdf).not.toHaveBeenCalled();
  });

  // ── Native extraction metadata ──────────────────────────────────────────────

  it("returns PDF metadata for native extraction", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue(pdfResult({
      scraperUsed: "pdf-native",
      ocrUsed: false,
      pageCount: 10,
      nativePages: 10,
      ocrPages: 0,
      pdfSizeBytes: 50000,
    }));

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.documentType).toBe("pdf");
    expect(body.scraperUsed).toBe("pdf-native");
    expect(body.ocrUsed).toBe(false);
    expect(body.pageCount).toBe(10);
    expect(body.nativePages).toBe(10);
    expect(body.ocrPages).toBe(0);
    expect(body.pdfSizeBytes).toBe(50000);
  });

  // ── Mixed extraction metadata ───────────────────────────────────────────────

  it("returns ocrUsed:true and pdf-mixed engine for mixed extraction", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue(pdfResult({
      scraperUsed: "pdf-mixed",
      ocrUsed: true,
      pageCount: 8,
      nativePages: 5,
      ocrPages: 3,
    }));

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.scraperUsed).toBe("pdf-mixed");
    expect(body.ocrUsed).toBe(true);
    expect(body.nativePages).toBe(5);
    expect(body.ocrPages).toBe(3);
  });

  // ── Scanned PDF (all OCR) ───────────────────────────────────────────────────

  it("returns pdf-ocr engine for fully scanned PDF", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue(pdfResult({
      scraperUsed: "pdf-ocr",
      ocrUsed: true,
      pageCount: 4,
      nativePages: 0,
      ocrPages: 4,
    }));

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.scraperUsed).toBe("pdf-ocr");
    expect(body.ocrUsed).toBe(true);
    expect(body.nativePages).toBe(0);
    expect(body.ocrPages).toBe(4);
  });

  // ── Error mappings ──────────────────────────────────────────────────────────

  it("returns 422 for encrypted PDF", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue({
      success: false,
      finalUrl: PDF_URL,
      scraperUsed: "" as const,
      title: "",
      content: "",
      statusCode: 200,
      error: "PDF is encrypted/password-protected",
    });

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(422);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(false);
    expect(body.documentType).toBe("pdf");
    expect(body.error).toMatch(/encrypted/i);
  });

  it("returns 422 for corrupt PDF", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue({
      success: false,
      finalUrl: PDF_URL,
      scraperUsed: "" as const,
      title: "",
      content: "",
      statusCode: 200,
      error: "Cannot open PDF: invalid format",
    });

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(422);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  it("returns 422 for page-limit exceeded", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue({
      success: false,
      finalUrl: PDF_URL,
      scraperUsed: "" as const,
      title: "",
      content: "",
      statusCode: 200,
      error: "PDF has 200 pages, exceeds limit of 100",
    });

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(422);
    expect((res.body as ScrapeResponseBody).error).toMatch(/pages/i);
  });

  it("returns 503 when PDF pool is full", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockRejectedValue(new PdfPoolFullError());

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(503);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  it("returns 504 when PDF extraction times out", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockRejectedValue(new PdfTimeoutError(60000));

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(504);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  it("returns 500 for unexpected PDF scraper error", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockRejectedValue(new Error("Internal worker crash"));

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.status).toBe(500);
    expect((res.body as ScrapeResponseBody).success).toBe(false);
  });

  // ── Existing HTML tests still work ─────────────────────────────────────────

  it("existing HTML scrape still works with documentType:html", async () => {
    mockSafeFetchBinary.mockResolvedValue(htmlPeek() as any);

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: HTML_URL });

    expect(res.status).toBe(200);
    const body = res.body as ScrapeResponseBody;
    expect(body.success).toBe(true);
    expect(body.documentType).toBe("html");
    expect(body.scraperUsed).toBe("static");
  });

  it("all required ScrapeResponseBody fields present on PDF success", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue(pdfResult());

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

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
    expect(body).toHaveProperty("documentType");
  });

  it("response is always JSON on PDF failure", async () => {
    mockSafeFetchBinary.mockResolvedValue(pdfPeek() as any);
    mockScrapePdf.mockResolvedValue({
      success: false,
      finalUrl: PDF_URL,
      scraperUsed: "" as const,
      title: "",
      content: "",
      statusCode: 200,
      error: "something went wrong",
    });

    const res = await request(app)
      .post("/api/scrape")
      .set(AUTH)
      .send({ url: PDF_URL });

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toBeTypeOf("object");
  });
});

describe("PDF pool queue deadline", () => {
  it("times out a queued job instead of waiting indefinitely", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = pdfPool.run(() => held);
    const second = pdfPool.run(() => held);

    await expect(pdfPool.run(async () => undefined, 10)).rejects.toBeInstanceOf(
      PdfTimeoutError,
    );

    release();
    await Promise.all([first, second]);
  });

  it("never runs more workers than the configured maximum", async () => {
    const pool = new PdfPool();
    const maxConcurrent = pool.stats.maxConcurrent;
    let running = 0;
    let highestRunning = 0;
    const releases: Array<() => void> = [];

    const jobs = Array.from({ length: maxConcurrent + 4 }, () =>
      pool.run(
        () =>
          new Promise<void>((resolve) => {
            running++;
            highestRunning = Math.max(highestRunning, running);
            releases.push(() => {
              running--;
              resolve();
            });
          }),
      ),
    );

    const waitForStartedCount = async (count: number): Promise<void> => {
      for (let attempt = 0; attempt < 100 && releases.length < count; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(releases.length).toBeGreaterThanOrEqual(count);
    };

    await waitForStartedCount(maxConcurrent);
    expect(highestRunning).toBe(maxConcurrent);

    for (let index = 0; index < jobs.length; index++) {
      releases[index]();
      if (index + maxConcurrent < jobs.length) {
        await waitForStartedCount(index + maxConcurrent + 1);
      }
      expect(highestRunning).toBeLessThanOrEqual(maxConcurrent);
      expect(pool.stats.active).toBeLessThanOrEqual(maxConcurrent);
    }

    await Promise.all(jobs);
    expect(pool.stats).toMatchObject({ active: 0, queued: 0 });
  });
});
