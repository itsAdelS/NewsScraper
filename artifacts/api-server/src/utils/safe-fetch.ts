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

/** Result returned by safeFetch. */
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
 * Custom `lookup` function compatible with `http.request` / `https.request`.
 *
 * Node.js passes this function the hostname it needs to resolve before
 * opening the TCP socket.  We resolve it ourselves, validate every returned
 * address, and hand back the chosen address.  Node.js then connects to THAT
 * address — it never calls the OS resolver again for this connection.
 *
 * This is the critical piece that closes the DNS-rebinding TOCTOU gap.
 */
function ssrfSafeLookup(
  rawHostname: string,
  _options: { family?: number; hints?: number; all?: boolean; verbatim?: boolean },
  callback: (err: Error | null, address: string, family: number) => void,
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
    callback(null, hostname, ipVersion);
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

      // Return the first valid address.  Node.js uses this for the TCP socket.
      const selected = validRecords[0];
      callback(null, selected.address, selected.family);
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
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
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
    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let oversize = false;

      res.on("data", (chunk: Buffer) => {
        if (oversize) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBodyBytes) {
          oversize = true;
          req.destroy(); // Stop reading; partial body is acceptable.
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });

      res.on("error", reject);
    });

    req.on("error", (err: Error) => {
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
 */
export async function safeFetch(startUrl: string): Promise<SafeFetchResult> {
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

    let response: Awaited<ReturnType<typeof issueRequest>>;
    try {
      response = await issueRequest(
        currentUrl,
        config.maxScraperTimeoutMs,
        config.maxBodyBytes,
      );
    } catch (err) {
      throw err; // UrlValidationError or plain Error — let callers handle.
    }

    // Handle redirects manually so each hop is validated by ssrfSafeLookup.
    const { statusCode, headers, body } = response;

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

    const html = body.toString("utf8");
    const truncatedBody = body.length >= config.maxBodyBytes;
    const contentType = Array.isArray(headers["content-type"])
      ? headers["content-type"][0]
      : headers["content-type"];

    return { html, finalUrl: currentUrl, statusCode, contentType, truncatedBody };
  }
}
