import { Router, type IRouter } from "express";
import { config } from "../config.js";
import { getOpsState } from "../lib/ops-state.js";
import {
  generateRequestId,
  domainOf,
  recordScrapeRequest,
} from "../lib/request-log.js";
import { browserPool } from "../scrapers/browser-pool.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  collectDiscoveryArticles,
  derivePayerName,
  DiscoveryInputError,
  DiscoveryNavigationError,
  renderDiscoveryLandingPage,
  resolveDiscoveryTarget,
  type DiscoveryRequestBody,
  type DiscoveryResponse,
} from "../scrapers/discovery.js";
import { BrowserPoolFullError } from "../scrapers/browser-pool.js";
import { UrlValidationError } from "../utils/validation.js";

const router: IRouter = Router();

router.post("/scrape/discovery", requireApiKey, async (req, res) => {
  const startedAt = Date.now();
  const requestId = generateRequestId();
  const poolAtStart = browserPool.stats;
  const body = req.body as Partial<DiscoveryRequestBody>;
  const diagnostics = {
    linksFound: 0,
    linksMatched: 0,
    pageRendered: false,
    errors: [] as string[],
  };

  const fail = (status: number, error: string) => {
    diagnostics.errors.push(error);
    recordScrapeRequest({
      requestId,
      url: typeof body.url === "string" ? body.url : "",
      finalUrl: "",
      domain: typeof body.url === "string" ? domainOf(body.url) : "",
      route: "discovery",
      scraperUsed: "discovery",
      documentType: "html",
      httpStatus: status,
      success: false,
      contentLength: 0,
      durationMs: Date.now() - startedAt,
      playwrightFallback: false,
      errorMessage: error,
      queueDepthAtStart: poolAtStart.queued,
      activeContextsAtStart: poolAtStart.active,
      contentPreview: null,
      discoveryArticles: 0,
    });
    res.status(status).json({ success: false, error, diagnostics, durationMs: Date.now() - startedAt });
  };

  const ops = getOpsState();
  if (!ops.acceptingRequests) {
    res.setHeader("Retry-After", String(config.pauseRetryAfterSeconds));
    fail(503, "Discovery is temporarily paused by administrator.");
    return;
  }
  if (typeof body.url !== "string" || body.url.trim() === "") {
    fail(400, "Missing required field: url");
    return;
  }

  let target;
  try {
    target = resolveDiscoveryTarget(body.targetMonth, body.targetYear);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "Invalid reporting period");
    return;
  }

  try {
    const page = await renderDiscoveryLandingPage(body.url, generateRequestId());
    diagnostics.pageRendered = true;
    diagnostics.linksFound = page.candidates.length;
    const articles = collectDiscoveryArticles(page.candidates, target);
    diagnostics.linksMatched = articles.length;
    recordScrapeRequest({
      requestId,
      url: body.url,
      finalUrl: page.finalUrl,
      domain: domainOf(body.url),
      route: "discovery",
      scraperUsed: "discovery",
      documentType: "html",
      httpStatus: 200,
      success: true,
      contentLength: articles.length,
      durationMs: Date.now() - startedAt,
      playwrightFallback: false,
      errorMessage: null,
      queueDepthAtStart: poolAtStart.queued,
      activeContextsAtStart: poolAtStart.active,
      contentPreview: null,
      discoveryArticles: articles.length,
    });

    const response: DiscoveryResponse = {
      PayerName: derivePayerName(page),
      Landingpagetitle: page.title,
      Targetmonth: target.month,
      TargetYear: String(target.year),
      Articlecount: articles.length,
      Articles: articles,
      diagnostics,
    };
    res.json(response);
  } catch (error) {
    if (error instanceof DiscoveryInputError) {
      fail(400, error.message);
    } else if (error instanceof UrlValidationError) {
      fail(error.httpStatus, error.message);
    } else if (error instanceof BrowserPoolFullError) {
      fail(503, error.message);
    } else if (error instanceof DiscoveryNavigationError) {
      fail(error.statusCode, error.message);
    } else {
      fail(500, `Unexpected discovery error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

export default router;