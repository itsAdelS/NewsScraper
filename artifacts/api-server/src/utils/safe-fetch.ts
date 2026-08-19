/**
 * SSRF-safe HTTP client built on Node.js's `node:http` / `node:https`.
 *
 * Why not `globalThis.fetch`?
 * Node.js's built-in fetch (undici) resolves the hostname independently of
 * any prior SSRF validation, creating a DNS-rebinding (TOCTOU) window:
 * validation uses one resolved IP, the actual TCP connection uses another.
 *
 * This module uses `http.request` / `https.request` with a custom `lookup`
 * callback that validates IPs before the TCP connection is established.
 * Because the same lookup result drives the real connection, DNS rebinding
 * is structurally prevented — the attacker can never cause the actual socket
 * to connect to an address that our lookup did not vet.
 *
 * The approach:
 *  1. Parse the URL and check the scheme.
 *  2. Call `ssrfSafeLookup`, which resolves the hostname and validates
 *     every returned address against private/reserved ranges.
 *  3. Pass that lookup function to `http(s).request`, so the OS resolver
 *     is NOT called again for the TCP connection — our validated IP is used.
 *  4. Manually follow redirects, running the same lookup on each hop.
 */

import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { isPrivateIp, UrlValidationError } from "./validation.js";
import { config, SCRAPER_USER_AGENT } from "../config.js";

/** Cloud metadata IP addresses that must be blocked unconditionally. */
const BLOCKED_METADATA_IPS = new Set([
  "169.254.169.254",
  "100.100.100.200",
]);

/** Hostname literals that are always blocked (before DNS resolution). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

/** Result returned by safeFetch (text-oriented). */
export interface SafeFetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  /** The Content-Type header returned by the server, if present. */
  contentType: string | undefined;
  /** True if the response body was truncated to maxBodyBytes. */
  truncatedBody: boolean;
}

/**
 * Result returned by safeFetchBinary — binary-safe, exposes the raw Buffer.
 * All existing SafeFetchResult consumers are unaffected.
 */
export interface SafeFetchBinaryResult {
  /** Raw response body as a Buffer (may be truncated — check truncatedBody). */
  body: Buffer;
  /** Final URL after all redirects. */
  finalUrl: string;
  /** HTTP status code of the final response. */
  statusCode: number;
  /** Content-Type header from the final response, if present. */
  contentType: string | undefined;
  /** True if the response body was truncated to maxBytes. */
  truncatedBody: boolean;
}

/** Options accepted by safeFetchBinary. */
export interface SafeFetchBinaryOptions {
  /** Maximum response body size in bytes. Defaults to config.maxBodyBytes. */
  maxBytes?: number;
  /** Request timeout in milliseconds. Defaults to config.maxScraperTimeoutMs. */
  timeoutMs?: number;
  /** Value of the Accept header. Defaults to a browser-like value. */
  accept?: string;
  /**
   * Optional lower body cap. When paired with extendBodyLimit, responses only
   * continue to maxBytes when the callback identifies a resource that needs it.
   */
  softMaxBytes?: number;
  extendBodyLimit?: (input: {
    bodyPrefix: Buffer;
    contentType: string | undefined;
    url: string;
  }) => boolean;
}

/**
 * Validated address entry returned by ssrfSafeLookup when options.all is true.
 * Matches the shape of `dns.LookupAddress` so Node.js's Happy Eyeballs
 * implementation can race IPv4 and IPv6 connections.
 */
type LookupAddressEntry = { address: string; family: number };

/**
 * Custom `lookup` function compatible with `http.request` / `https.request`.
 *
 * Node.js passes this function the hostname it needs to resolve before
 * opening the TCP socket.  We resolve it ourselves, validate every returned
 * address, and hand back the chosen address.  Node.js then connects to THAT
 * address — it never calls the OS resolver again for this connection.
 *
 * This is the critical piece that closes the DNS-rebinding TOCTOU gap.
 *
 * Node.js v22+ passes options.all = true (Happy Eyeballs / dual-stack) and
 * expects the callback to receive an array of {address, family} objects.
 * Node.js v18–v21 passes options.all = false (or omits it) and expects a
 * single string address.  We handle both forms.
 */
function ssrfSafeLookup(
  rawHostname: string,
  options: { family?: number; hints?: number; all?: boolean; verbatim?: boolean },
  callback: (err: Error | null, address: string | LookupAddressEntry[], family: number) => void,
): void {
  // Strip IPv6 brackets: new URL("http://[::1]/").hostname returns "[::1]"
  // but http.request also strips them before calling lookup — handle both.
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Block by hostname literal (before any DNS resolution).
  if (
    BLOCKED_HOSTNAMES.has(hostname.toLowerCase()) ||
    BLOCKED_METADATA_IPS.has(hostname)
  ) {
    callback(new Error(`SSRF: '${hostname}' is blocked`), "", 0);
    return;
  }

  // If the hostname is already an IP literal, validate it directly.
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    if (isPrivateIp(hostname) || BLOCKED_METADATA_IPS.has(hostname)) {
      callback(
        new Error(`SSRF: ${hostname} is a private/reserved address`),
        "",
        0,
      );
      return;
    }
    // Return in the format the caller expects.
    if (options.all) {
      callback(null, [{ address: hostname, family: ipVersion }], 0);
    } else {
      callback(null, hostname, ipVersion);
    }
    return;
  }

  // Resolve the hostname and validate every returned address.
  dnsLookup(hostname, { all: true })
    .then((records) => {
      const validRecords = records.filter(
        (r) => !isPrivateIp(r.address) && !BLOCKED_METADATA_IPS.has(r.address),
      );

      if (validRecords.length === 0) {
        callback(
          new Error(
            `SSRF: '${hostname}' resolves only to private/reserved addresses`,
          ),
          "",
          0,
        );
        return;
      }

      // Node.js v22+ (Happy Eyeballs) calls with options.all = true and
      // expects an array of {address, family} objects so it can race
      // IPv4 and IPv6 connections.  Older versions expect a single string.
      if (options.all) {
        // Return all valid addresses; family = 0 means "mixed" per Node.js convention.
        callback(null, validRecords, 0);
      } else {
        const selected = validRecords[0];
        callback(null, selected.address, selected.family);
      }
    })
    .catch((err: unknown) => {
      callback(
        err instanceof Error ? err : new Error(String(err)),
        "",
        0,
      );
    });
}

/** Issue a single HTTP/HTTPS request (no redirect following). */
function issueRequest(
  urlStr: string,
  timeoutMs: number,
  maxBodyBytes: number,
  accept?: string,
  softMaxBodyBytes = maxBodyBytes,
  extendBodyLimit?: SafeFetchBinaryOptions["extendBodyLimit"],
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncatedBody: boolean;
}> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === "https:";

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port !== "" ? Number(parsedUrl.port) : (isHttps ? 443 : 80),
      path: (parsedUrl.pathname || "/") + parsedUrl.search,
      method: "GET",
      headers: {
        "User-Agent": SCRAPER_USER_AGENT,
        Accept:
          accept ??
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Host: parsedUrl.host,
      },
      timeout: timeoutMs,
      // THE KEY: same lookup drives both validation and TCP connection.
      lookup: ssrfSafeLookup,
      rejectUnauthorized: true,
    };

    const transport = isHttps ? https : http;
    let settled = false;
    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let effectiveMaxBodyBytes = softMaxBodyBytes;
      let bodyLimitResolved = !extendBodyLimit;
      let bodyPrefix = Buffer.alloc(0);

      const finish = (truncatedBody: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncatedBody,
        });
      };

      res.on("data", (chunk: Buffer) => {
        if (!bodyLimitResolved) {
          const needed = 1024 - bodyPrefix.length;
          if (needed > 0) {
            bodyPrefix = Buffer.concat([
              bodyPrefix,
              chunk.subarray(0, needed),
            ]);
          }
          if (bodyPrefix.length >= 1024) {
            const header = res.headers["content-type"];
            const contentType = Array.isArray(header) ? header[0] : header;
            effectiveMaxBodyBytes = extendBodyLimit?.({
              bodyPrefix,
              contentType,
              url: urlStr,
            })
              ? maxBodyBytes
              : softMaxBodyBytes;
            bodyLimitResolved = true;
          }
        }

        const remaining = effectiveMaxBodyBytes - totalBytes;
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          totalBytes = effectiveMaxBodyBytes;
          finish(true);
          res.destroy();
          return;
        }
        chunks.push(chunk);
        totalBytes += chunk.length;
      });

      res.on("end", () => {
        finish(false);
      });

      res.on("error", (err) => {
        if (!settled) reject(err);
      });
    });

    req.on("error", (err: Error) => {
      if (settled) return;
      const msg = err.message ?? "";
      // Surface SSRF blocks as UrlValidationError so callers can map them to
      // HTTP 403 rather than 500.
      if (msg.startsWith("SSRF:")) {
        reject(new UrlValidationError(msg, 403));
      } else if (msg.toLowerCase().includes("certificate")) {
        reject(new UrlValidationError(`TLS certificate error: ${msg}`, 400));
      } else {
        reject(err);
      }
    });

    req.on("timeout", () => {
      req.destroy(
        new Error(`Request timed out after ${timeoutMs}ms`),
      );
    });

    req.end();
  });
}

/**
 * Fetch a URL safely:
 *  - SSRF-safe: the TCP connection uses a validated IP (no DNS rebinding).
 *  - Follows up to `config.maxRedirects` redirects, re-validating each hop.
 *  - Enforces body size and timeout limits.
 *  - Throws `UrlValidationError` for SSRF violations (HTTP 403).
 *  - Throws a plain `Error` for network/timeout issues.
 *
 * Returns a text (UTF-8) body via the `html` field.
 * Use `safeFetchBinary` when you need the raw Buffer (e.g. PDF downloads).
 */
export async function safeFetch(startUrl: string): Promise<SafeFetchResult> {
  const bin = await safeFetchBinary(startUrl);
  const html = bin.body.toString("utf8");
  return {
    html,
    finalUrl: bin.finalUrl,
    statusCode: bin.statusCode,
    contentType: bin.contentType,
    truncatedBody: bin.truncatedBody,
  };
}

/**
 * Binary-safe variant of safeFetch.
 *
 * Returns the raw response Buffer instead of decoding to UTF-8. Useful for
 * detecting and downloading PDF/binary responses without charset corruption.
 *
 * Accepts configurable timeout, max body size, and Accept header so the PDF
 * pipeline can tune them independently of the HTML scraper defaults.
 *
 * All SSRF protections and redirect handling are identical to safeFetch.
 */
export async function safeFetchBinary(
  startUrl: string,
  opts: SafeFetchBinaryOptions = {},
): Promise<SafeFetchBinaryResult> {
  const maxBodyBytes = opts.maxBytes ?? config.maxBodyBytes;
  const timeoutMs = opts.timeoutMs ?? config.maxScraperTimeoutMs;
  const accept = opts.accept;
  const softMaxBodyBytes = Math.min(
    opts.softMaxBytes ?? maxBodyBytes,
    maxBodyBytes,
  );

  let currentUrl = startUrl;
  let redirectsLeft = config.maxRedirects;

  while (true) {
    // Scheme check (before DNS — fast fail for non-http(s) URLs).
    const scheme = new URL(currentUrl).protocol;
    if (scheme !== "https:" && scheme !== "http:") {
      throw new UrlValidationError(
        `Unsupported URL scheme '${scheme.replace(":", "")}'. Only http and https are allowed.`,
        400,
      );
    }

    const response = await issueRequest(
      currentUrl,
      timeoutMs,
      maxBodyBytes,
      accept,
      softMaxBodyBytes,
      opts.extendBodyLimit,
    );

    // Handle redirects manually so each hop is validated by ssrfSafeLookup.
    const { statusCode, headers, body, truncatedBody } = response;

    if (statusCode >= 300 && statusCode < 400) {
      if (redirectsLeft <= 0) {
        throw new Error(
          `Too many redirects (max ${config.maxRedirects}) while fetching ${startUrl}`,
        );
      }
      const location = headers["location"];
      if (!location) {
        throw new Error("Redirect response missing Location header");
      }
      // Resolve relative Location URLs against the current URL.
      currentUrl = new URL(location, currentUrl).href;
      redirectsLeft--;
      continue;
    }

    const contentType = Array.isArray(headers["content-type"])
      ? headers["content-type"][0]
      : headers["content-type"];

    return { body, finalUrl: currentUrl, statusCode, contentType, truncatedBody };
  }
}
