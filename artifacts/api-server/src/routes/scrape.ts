/**
 * POST /api/scrape — main scraping endpoint.
 *
 * Accepts: { url: string, route?: string }
 * Returns: ScrapeResponseBody (always JSON, success or failure)
 *
 * PDF detection:
 *  1. Download the response once with the binary-safe, SSRF-protected client.
 *  2. Inspect Content-Type header and magic bytes (%PDF-).
 *  3. Confirmed PDFs → PDF scraper pipeline.
 *  4. Everything else (including HTML served from a .pdf URL) → HTML path.
 */

import { Router, type IRouter } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { resolveRoute, getScraper } from "../scrapers/registry.js";
import { validateUrl, UrlValidationError } from "../utils/validation.js";
import { BrowserPoolFullError } from "../scrapers/browser-pool.js";
import { PdfPoolFullError, PdfTimeoutError } from "../scrapers/pdf-pool.js";
import { detectPdf, scrapePdf } from "../scrapers/pdf-scraper.js";
import { safeFetchBinary } from "../utils/safe-fetch.js";
import { config } from "../config.js";
import type {
  ScrapeRequestBody,
  ScrapeResponseBody,
  DocumentType,
  FetchedHtmlPage,
} from "../scrapers/types.js";
import type { SafeFetchBinaryResult } from "../utils/safe-fetch.js";
import { logger } from "../lib/logger.js";
import { getOpsState } from "../lib/ops-state.js";
import { browserPool } from "../scrapers/browser-pool.js";
import {
  generateRequestId,
  domainOf,
  recordScrapeRequest,
  PREVIEW_MAX_CHARS,
} from "../lib/request-log.js";

const router: IRouter = Router();

router.post("/scrape", requireApiKey, async (req, res) => {
  // Reject new work while paused/draining — BEFORE any scraping starts.
  // Active and queued jobs are unaffected; this only gates new requests.
  const ops = getOpsState();
  if (!ops.acceptingRequests) {
    res.setHeader("Retry-After", String(config.pauseRetryAfterSeconds));
    res.status(503).json({
      success: false,
      status: ops.mode === "drain" ? "draining" : "paused",
      error: "Scraping is temporarily paused by administrator.",
      retryAfterSeconds: config.pauseRetryAfterSeconds,
    });
    return;
  }

  const requestId = generateRequestId();
  const startMs = Date.now();
  const poolAtStart = browserPool.stats;

  const body = req.body as Partial<ScrapeRequestBody>;
  const rawUrl = body.url;
  const rawRoute = body.route;

  /** Persist request metadata for the admin console (fire-and-forget). */
  const logRequest = (opts: {
    route: string;
    success: boolean;
    finalUrl?: string;
    scraperUsed?: string;
    httpStatus?: number;
    contentLength?: number;
    error?: string;
    preview?: string;
    documentType?: DocumentType;
    ocrUsed?: boolean;
    pageCount?: number;
    nativePages?: number;
    ocrPages?: number;
    pdfSizeBytes?: number;
  }): void => {
    recordScrapeRequest({
      requestId,
      url: typeof rawUrl === "string" ? rawUrl : "",
      finalUrl: opts.finalUrl ?? "",
      domain: typeof rawUrl === "string" ? domainOf(rawUrl) : "",
      route: opts.route,
      scraperUsed: opts.scraperUsed ?? "",
      documentType: opts.documentType ?? "html",
      ocrUsed: opts.ocrUsed ?? false,
      pageCount: opts.pageCount ?? 0,
      nativePages: opts.nativePages ?? 0,
      ocrPages: opts.ocrPages ?? 0,
      pdfSizeBytes: opts.pdfSizeBytes ?? 0,
      httpStatus: opts.httpStatus ?? 0,
      success: opts.success,
      contentLength: opts.contentLength ?? 0,
      durationMs: Date.now() - startMs,
      playwrightFallback: opts.scraperUsed === "playwright",
      errorMessage: opts.error ?? null,
      queueDepthAtStart: poolAtStart.queued,
      activeContextsAtStart: poolAtStart.active,
      contentPreview:
        config.logContentPreview && opts.preview
          ? opts.preview.slice(0, PREVIEW_MAX_CHARS)
          : null,
    });
  };

  // --- Request validation ---
  if (!rawUrl) {
    logRequest({ route: rawRoute ?? "generic", success: false, error: "Missing required field: url" });
    res.status(400).json(errorResponse("", rawRoute ?? "generic", "", 0, "Missing required field: url"));
    return;
  }

  if (typeof rawUrl !== "string") {
    logRequest({ route: rawRoute ?? "generic", success: false, error: "Field 'url' must be a string" });
    res.status(400).json(errorResponse("", rawRoute ?? "generic", "", 0, "Field 'url' must be a string"));
    return;
  }

  // Validate URL and SSRF up-front.
  try {
    await validateUrl(rawUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      const httpStatus = err.httpStatus === 403 ? 403 : 400;
      logRequest({ route: rawRoute ?? "generic", success: false, httpStatus, error: err.message });
      res.status(httpStatus).json(
        errorResponse(rawUrl, rawRoute ?? "generic", "", 0, err.message),
      );
      return;
    }
    throw err;
  }

  const route = resolveRoute(rawRoute, rawUrl);

  // ── PDF detection: probe the URL before deciding which path to take ────────
  //
  // We do one binary-safe fetch, inspect Content-Type/magic/URL, then hand the
  // exact response to either the existing static HTML path or the PDF worker.
  // HTML retains its original 10 MB body cap; only confirmed PDF responses are
  // allowed to continue to the larger PDF limit.

  let isPdf = false;
  let fetched: SafeFetchBinaryResult | undefined;
  try {
    // Download once, then reuse these exact bytes in the selected pipeline.
    // This preserves one-time URLs and avoids duplicate traffic.
    fetched = await safeFetchBinary(rawUrl, {
      maxBytes: config.maxPdfSizeMb * 1024 * 1024,
      softMaxBytes: config.maxBodyBytes,
      timeoutMs: config.maxScraperTimeoutMs,
      extendBodyLimit: ({ bodyPrefix, contentType, url }) =>
        detectPdf(bodyPrefix, contentType, url),
    });
    isPdf = detectPdf(fetched.body, fetched.contentType, fetched.finalUrl);
    logger.debug(
      {
        requestId,
        url: rawUrl,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        isPdf,
      },
      "Scrape: PDF detection result",
    );
  } catch (err) {
    // Sniff failed — fall through to the HTML scraper path which will
    // produce its own error (consistent with prior behaviour).
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ requestId, url: rawUrl, error: msg }, "Scrape: PDF sniff failed, falling back to HTML path");

    if (err instanceof UrlValidationError) {
      const httpStatus = err.httpStatus === 403 ? 403 : 400;
      logRequest({ route, success: false, httpStatus, error: err.message });
      res.status(httpStatus).json(errorResponse(rawUrl, route, "", 0, err.message));
      return;
    }
  }

  // ── Branch: PDF pipeline ───────────────────────────────────────────────────
  if (isPdf) {
    logger.info({ requestId, url: rawUrl, route }, "Scrape: routing to PDF pipeline");

    let result;
    try {
      result = await scrapePdf(rawUrl, requestId, fetched);
    } catch (err) {
      const durationMs = Date.now() - startMs;

      if (err instanceof PdfPoolFullError) {
        logger.warn({ requestId, url: rawUrl, durationMs }, "PDF pool full — returning 503");
        logRequest({ route, success: false, httpStatus: 503, error: (err as Error).message, documentType: "pdf" });
        res.status(503).json(errorResponse(rawUrl, route, "", durationMs, (err as Error).message, "pdf"));
        return;
      }

      if (err instanceof PdfTimeoutError) {
        logger.warn({ requestId, url: rawUrl, durationMs }, "PDF extraction timed out — returning 504");
        logRequest({ route, success: false, httpStatus: 504, error: (err as Error).message, documentType: "pdf" });
        res.status(504).json(errorResponse(rawUrl, route, "", durationMs, (err as Error).message, "pdf"));
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ requestId, url: rawUrl, route, error: msg, durationMs }, "PDF scraper threw unexpected error");
      logRequest({ route, success: false, httpStatus: 500, error: `Unexpected PDF scraper error: ${msg}`, documentType: "pdf" });
      res.status(500).json(errorResponse(rawUrl, route, "", durationMs, `Unexpected PDF scraper error: ${msg}`, "pdf"));
      return;
    }

    const durationMs = Date.now() - startMs;

    // Truncate content if it exceeds the configured maximum.
    let content = result.content;
    let truncated = false;
    if (content.length > config.maxExtractedChars) {
      content = content.slice(0, config.maxExtractedChars);
      truncated = true;
    }

    // Determine HTTP status for PDF errors.
    let httpStatus = 200;
    if (!result.success) {
      if (result.statusCode === 403) httpStatus = 403;
      else if (result.statusCode === 404) httpStatus = 404;
      else if (
        result.statusCode === 504 ||
        result.error?.toLowerCase().includes("timed out")
      ) {
        httpStatus = 504;
      } else {
        httpStatus = 422;
      }
    }

    const documentType: DocumentType = "pdf";

    const response: ScrapeResponseBody = {
      success: result.success,
      url: rawUrl,
      finalUrl: result.finalUrl,
      route,
      scraperUsed: result.scraperUsed,
      title: result.title,
      content,
      contentLength: content.length,
      statusCode: result.statusCode || (result.success ? 200 : 500),
      durationMs,
      truncated,
      documentType,
      ...(result.error ? { error: result.error } : {}),
      ...(result.ocrUsed !== undefined ? { ocrUsed: result.ocrUsed } : {}),
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
      ...(result.nativePages !== undefined ? { nativePages: result.nativePages } : {}),
      ...(result.ocrPages !== undefined ? { ocrPages: result.ocrPages } : {}),
      ...(result.pdfSizeBytes !== undefined ? { pdfSizeBytes: result.pdfSizeBytes } : {}),
    };

    logger.info(
      {
        requestId,
        url: rawUrl,
        finalUrl: result.finalUrl,
        route,
        scraperUsed: result.scraperUsed,
        success: result.success,
        statusCode: result.statusCode,
        contentLength: content.length,
        truncated,
        durationMs,
        ocrUsed: result.ocrUsed,
        pageCount: result.pageCount,
      },
      "Scrape (PDF) complete",
    );

    logRequest({
      route,
      success: result.success,
      finalUrl: result.finalUrl,
      scraperUsed: result.scraperUsed,
      httpStatus: response.statusCode,
      contentLength: content.length,
      error: result.error,
      preview: result.success ? content : undefined,
      documentType,
      ocrUsed: result.ocrUsed,
      pageCount: result.pageCount,
      nativePages: result.nativePages,
      ocrPages: result.ocrPages,
      pdfSizeBytes: result.pdfSizeBytes,
    });

    res.status(httpStatus).json(response);
    return;
  }

  // ── Branch: HTML pipeline (existing behaviour, unchanged) ─────────────────
  const scraper = getScraper(route);
  const prefetchedHtml: FetchedHtmlPage | undefined = fetched
    ? {
        html: fetched.body.subarray(0, config.maxBodyBytes).toString("utf8"),
        finalUrl: fetched.finalUrl,
        statusCode: fetched.statusCode,
        contentType: fetched.contentType,
        truncatedBody:
          fetched.truncatedBody || fetched.body.length > config.maxBodyBytes,
      }
    : undefined;

  logger.info({ requestId, url: rawUrl, route }, "Scrape request started");

  let result;
  try {
    result = await scraper.scrape(rawUrl, requestId, prefetchedHtml);
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;

    // Browser pool is at capacity — return 503 so Power Automate can retry.
    if (err instanceof BrowserPoolFullError) {
      logger.warn({ requestId, url: rawUrl, route, durationMs }, "Browser pool full — returning 503");
      logRequest({ route, success: false, httpStatus: 503, error: err.message });
      res.status(503).json(
        errorResponse(rawUrl, route, "", durationMs, err.message),
      );
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ requestId, url: rawUrl, route, error: msg, durationMs }, "Scraper threw unexpected error");
    logRequest({ route, success: false, httpStatus: 500, error: `Unexpected scraper error: ${msg}` });

    res.status(500).json(
      errorResponse(rawUrl, route, "", durationMs, `Unexpected scraper error: ${msg}`),
    );
    return;
  }

  const durationMs = Date.now() - startMs;

  // Truncate content if it exceeds the configured maximum.
  let content = result.content;
  let truncated = false;
  if (content.length > config.maxExtractedChars) {
    content = content.slice(0, config.maxExtractedChars);
    truncated = true;
  }

  // Choose the appropriate HTTP status for the response envelope.
  let httpStatus = 200;
  if (!result.success) {
    if (result.statusCode === 403) httpStatus = 403;
    else if (result.statusCode === 404) httpStatus = 404;
    else if (result.statusCode === 504 || result.error?.includes("timeout")) httpStatus = 504;
    else httpStatus = 422;
  }

  const response: ScrapeResponseBody = {
    success: result.success,
    url: rawUrl,
    finalUrl: result.finalUrl,
    route,
    scraperUsed: result.scraperUsed,
    title: result.title,
    content,
    contentLength: content.length,
    statusCode: result.statusCode || (result.success ? 200 : 500),
    durationMs,
    truncated,
    documentType: "html",
    ...(result.error ? { error: result.error } : {}),
  };

  logger.info(
    {
      requestId,
      url: rawUrl,
      finalUrl: result.finalUrl,
      route,
      scraperUsed: result.scraperUsed,
      success: result.success,
      statusCode: result.statusCode,
      contentLength: content.length,
      truncated,
      durationMs,
    },
    "Scrape request complete",
  );

  logRequest({
    route,
    success: result.success,
    finalUrl: result.finalUrl,
    scraperUsed: result.scraperUsed,
    httpStatus: response.statusCode,
    contentLength: content.length,
    error: result.error,
    preview: result.success ? content : undefined,
  });

  res.status(httpStatus).json(response);
});

/** Build a standardised error response body. */
function errorResponse(
  url: string,
  route: string,
  finalUrl: string,
  durationMs: number,
  error: string,
  documentType: DocumentType = "html",
): ScrapeResponseBody {
  return {
    success: false,
    url,
    finalUrl,
    route,
    scraperUsed: "",
    title: "",
    content: "",
    contentLength: 0,
    statusCode: 0,
    durationMs,
    truncated: false,
    documentType,
    error,
  };
}

export default router;
