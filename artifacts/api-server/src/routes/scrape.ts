/**
 * POST /api/scrape — main scraping endpoint.
 *
 * Accepts: { url: string, route?: string }
 * Returns: ScrapeResponseBody (always JSON, success or failure)
 */

import { Router, type IRouter } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { resolveRoute, getScraper } from "../scrapers/registry.js";
import { validateUrl, UrlValidationError } from "../utils/validation.js";
import { config } from "../config.js";
import type { ScrapeRequestBody, ScrapeResponseBody } from "../scrapers/types.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

router.post("/scrape", requireApiKey, async (req, res) => {
  const requestId = (req as { id?: string }).id?.toString() ?? randomUUID().slice(0, 8);
  const startMs = Date.now();

  const body = req.body as Partial<ScrapeRequestBody>;
  const rawUrl = body.url;
  const rawRoute = body.route;

  // --- Request validation ---
  if (!rawUrl) {
    res.status(400).json(errorResponse("", rawRoute ?? "generic", "", 0, "Missing required field: url"));
    return;
  }

  if (typeof rawUrl !== "string") {
    res.status(400).json(errorResponse("", rawRoute ?? "generic", "", 0, "Field 'url' must be a string"));
    return;
  }

  // Validate URL and SSRF up-front.
  try {
    await validateUrl(rawUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      const httpStatus = err.httpStatus === 403 ? 403 : 400;
      res.status(httpStatus).json(
        errorResponse(rawUrl, rawRoute ?? "generic", "", 0, err.message),
      );
      return;
    }
    throw err;
  }

  const route = resolveRoute(rawRoute, rawUrl);
  const scraper = getScraper(route);

  logger.info({ requestId, url: rawUrl, route }, "Scrape request started");

  let result;
  try {
    result = await scraper.scrape(rawUrl, requestId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;

    logger.error({ requestId, url: rawUrl, route, error: msg, durationMs }, "Scraper threw unexpected error");

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

  res.status(httpStatus).json(response);
});

/** Build a standardised error response body. */
function errorResponse(
  url: string,
  route: string,
  finalUrl: string,
  durationMs: number,
  error: string,
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
    error,
  };
}

export default router;
