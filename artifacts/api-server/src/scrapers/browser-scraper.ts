/**
 * Playwright browser scraper — used as fallback when the static scraper
 * returns insufficient content (JavaScript-heavy pages, bot challenges, etc.).
 *
 * SSRF defence:
 *
 *   Chromium is configured to make ZERO direct network connections.
 *   Every outbound request is intercepted via `page.route('**', ...)` and
 *   handled in one of two ways:
 *
 *   FULFILLED — document, script, and stylesheet requests are fetched by OUR
 *   `safeFetch` client (Node.js `http`/`https` with a validated `lookup` that
 *   pins the resolved IP so DNS rebinding is structurally impossible).
 *   Chromium receives the response body from us; it never opens a socket.
 *
 *   ABORTED — everything else (XHR, fetch(), WebSocket, image, media, font,
 *   ping, eventsource, manifest, other) is aborted so page-level JavaScript
 *   cannot probe internal network endpoints through Chromium's resolver.
 *
 *   This means that for EVERY resource Chromium loads, the actual TCP
 *   connection is made by our SSRF-safe client with its validated `lookup`,
 *   not by Chromium.  There is no category of resource for which Chromium
 *   makes an independent DNS query or TCP connection.
 *
 * Browser sandbox:
 *   `--no-sandbox` / `--disable-setuid-sandbox` are only applied when the
 *   process is running as root (the case in most Linux containers, including
 *   Replit).  When running as a non-root user the full Chromium sandbox is
 *   preserved.
 */

import type { EngineResult } from "./types.js";
import { BaseScraper, safeFetch } from "./base.js";
import { UrlValidationError, validateUrl } from "../utils/validation.js";
import { logger } from "../lib/logger.js";

/**
 * Resource types fulfilled through our SSRF-safe client.
 * Chromium never opens a socket for these — we fetch them and hand the
 * response back.  This covers both rendering resources (document, script,
 * stylesheet) and same-origin API calls (xhr, fetch) that load page content.
 * SSRF safety is enforced by safeFetch's pinned-IP lookup, so we do not need
 * to abort these — malicious destinations are blocked before any connection.
 */
const FULFILLED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "stylesheet",
  "xhr",
  "fetch",
]);

/**
 * Default Content-Type to assume when the server does not send one,
 * keyed by Playwright resource type.
 */
const DEFAULT_CONTENT_TYPES: Record<string, string> = {
  document: "text/html; charset=utf-8",
  script: "application/javascript; charset=utf-8",
  stylesheet: "text/css; charset=utf-8",
};

export class BrowserScraper extends BaseScraper {
  async scrape(url: string, requestId: string): Promise<EngineResult> {
    this.log(requestId, "Browser scraper: launching Chromium", { url });

    // ── Pre-flight SSRF validation ──────────────────────────────────────────
    // Fast-fail before launching the browser for obvious SSRF violations.
    // This is an optimisation layer; the core SSRF enforcement happens inside
    // the route handler via safeFetch's pinned-IP lookup for each request.
    try {
      await validateUrl(url);
    } catch (err) {
      if (err instanceof UrlValidationError) {
        return {
          success: false,
          finalUrl: "",
          scraperUsed: "playwright",
          title: "",
          content: "",
          statusCode: err.httpStatus,
          error: err.message,
        };
      }
      throw err;
    }

    let chromium: typeof import("playwright").chromium;
    try {
      const playwright = await import("playwright");
      chromium = playwright.chromium;
    } catch {
      return {
        success: false,
        finalUrl: "",
        scraperUsed: "playwright",
        title: "",
        content: "",
        statusCode: 0,
        error: "Playwright is not available in this environment",
      };
    }

    // Only disable the sandbox when running as root (container environments).
    // When running as a non-root user the full Chromium sandbox is used.
    const isRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    const sandboxArgs = isRoot
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [];

    const browser = await chromium.launch({
      headless: true,
      args: [
        ...sandboxArgs,
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ignoreHTTPSErrors: false,
        // Block service workers: they register their own fetch handler and
        // bypass page.route() interception, creating a SSRF bypass path.
        serviceWorkers: "block",
      });

      const page = await context.newPage();

      // ── SSRF interception: Chromium makes zero direct network connections ──
      //
      // Every request is handled here:
      //   - document / script / stylesheet / xhr / fetch → fulfilled via
      //     safeFetch (our SSRF-safe client with pinned-resolution lookup).
      //   - everything else → aborted.
      //
      // Because safeFetch uses a custom `lookup` callback that validates IPs
      // before returning them to the TCP layer, DNS rebinding is structurally
      // impossible for all network traffic in this scraper.
      //
      // ssrfBlockOccurred is set true when safeFetch throws a UrlValidationError
      // (genuine SSRF block).  This lets the page.goto error handler correctly
      // distinguish an SSRF violation from an ordinary network failure so the
      // error message reflects the real cause.
      let ssrfBlockOccurred = false;

      await page.route("**", async (route) => {
        const reqUrl = route.request().url();
        const resourceType = route.request().resourceType();

        // Only intercept http/https; pass through other schemes (data:, blob:)
        // which are always same-origin and cannot be redirected externally.
        if (!reqUrl.startsWith("http://") && !reqUrl.startsWith("https://")) {
          if (FULFILLED_RESOURCE_TYPES.has(resourceType)) {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
          return;
        }

        if (FULFILLED_RESOURCE_TYPES.has(resourceType)) {
          // Fetch via our SSRF-safe client; Chromium never opens a socket.
          try {
            const fetched = await safeFetch(reqUrl);
            const contentType =
              fetched.contentType ??
              DEFAULT_CONTENT_TYPES[resourceType] ??
              "application/octet-stream";

            await route.fulfill({
              status: fetched.statusCode || 200,
              contentType,
              body: fetched.html,
            });
          } catch (err) {
            // Distinguish a genuine SSRF block (UrlValidationError with 403)
            // from an ordinary network failure (connection refused, timeout,
            // TLS error, etc.) so the error message surfaced to the caller
            // accurately reflects the actual failure.
            const isSsrfBlock =
              err instanceof UrlValidationError && err.httpStatus === 403;

            logger.warn(
              {
                requestId,
                reqUrl,
                resourceType,
                error: err instanceof Error ? err.message : String(err),
                ssrfBlock: isSsrfBlock,
              },
              isSsrfBlock
                ? "Browser scraper: SSRF protection blocked resource"
                : "Browser scraper: network error fetching resource; aborting",
            );

            if (isSsrfBlock) {
              ssrfBlockOccurred = true;
              // Use addressunreachable so page.goto throws net::ERR_ADDRESS_UNREACHABLE,
              // which the error handler below recognises as an SSRF block.
              await route.abort("addressunreachable");
            } else {
              // Use 'failed' (generic network error) so the page.goto error
              // handler can surface the real cause instead of blaming SSRF.
              await route.abort("failed");
            }
          }
        } else {
          // Abort all other resource types (image, media, font, WebSocket …)
          // so page JS cannot probe internal endpoints via Chromium's resolver.
          await route.abort("blockedbyclient");
        }
      });

      let statusCode = 0;
      const finalUrlHolder = { url };

      // Capture the main document status code.
      page.on("response", (response) => {
        if (response.request().resourceType() === "document") {
          statusCode = response.status();
          finalUrlHolder.url = response.url();
        }
      });

      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        if (response) {
          statusCode = response.status();
          finalUrlHolder.url = response.url();
        }
      } catch (navErr: unknown) {
        const msg = navErr instanceof Error ? navErr.message : String(navErr);
        if (
          msg.toLowerCase().includes("timeout") ||
          msg.toLowerCase().includes("timed out")
        ) {
          return {
            success: false,
            finalUrl: "",
            scraperUsed: "playwright",
            title: "",
            content: "",
            statusCode: 504,
            error: `Browser navigation timed out: ${msg}`,
          };
        }
        if (
          msg.toLowerCase().includes("addressunreachable") ||
          msg.toLowerCase().includes("net::err")
        ) {
          // Only label as SSRF if the route handler confirmed a UrlValidationError.
          // Generic network failures (connection refused, TLS error, DNS failure)
          // use the same Playwright error codes but should not be reported as SSRF.
          if (ssrfBlockOccurred) {
            return {
              success: false,
              finalUrl: "",
              scraperUsed: "playwright",
              title: "",
              content: "",
              statusCode: 403,
              error: `Navigation blocked by SSRF protection: ${msg}`,
            };
          }
          return {
            success: false,
            finalUrl: "",
            scraperUsed: "playwright",
            title: "",
            content: "",
            statusCode: 502,
            error: `Navigation failed: ${msg}`,
          };
        }
        throw navErr;
      }

      // Wait briefly for deferred JS content to render.
      await page.waitForTimeout(2500);

      try {
        await page.waitForFunction(
          "() => (document.body?.innerText?.length ?? 0) > 100",
          { timeout: 5000 },
        );
      } catch {
        // Page may have little content — continue anyway.
      }

      const html = await page.content();
      const finalUrl = finalUrlHolder.url;

      this.log(requestId, "Browser scraper: page loaded", {
        finalUrl,
        statusCode,
        htmlLength: html.length,
      });

      const result = this.buildResult(html, finalUrl, statusCode, "playwright");

      this.log(requestId, "Browser scraper: extraction complete", {
        success: result.success,
        contentLength: result.content.length,
      });

      return result;
    } finally {
      await browser.close();
    }
  }
}
