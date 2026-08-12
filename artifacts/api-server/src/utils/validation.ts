/**
 * URL validation and SSRF protection utilities.
 *
 * Rules:
 *  - Only https:// and http:// schemes are allowed.
 *  - The resolved IP(s) must not be private, loopback, link-local, CGNAT,
 *    or cloud-metadata addresses.
 *  - Every redirect destination is re-validated before following.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Cloud metadata endpoint IPs that are unconditionally blocked. */
const BLOCKED_METADATA_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure IMDS
  "100.100.100.200", // Alibaba Cloud metadata
]);

/** Blocked hostname literals (before DNS resolution). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

export class UrlValidationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: 400 | 403,
  ) {
    super(message);
    this.name = "UrlValidationError";
  }
}

/**
 * Returns true when the given IPv4 or IPv6 address falls within a
 * private / reserved / dangerous range.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 || // 0.0.0.0/8 — "this" network
      a === 10 || // 10.0.0.0/8 — private
      a === 127 || // 127.0.0.0/8 — loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — CGNAT
      (a === 169 && b === 254) || // 169.254.0.0/16 — link-local
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — private
      (a === 192 && b === 168) || // 192.168.0.0/16 — private
      a >= 240 // 240.0.0.0/4 — reserved
    );
  }

  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();

    // IPv4-mapped: ::ffff:x.x.x.x — extract and re-check the IPv4 part.
    if (lower.startsWith("::ffff:")) {
      const ipv4Part = ip.slice(7);
      if (isIP(ipv4Part) === 4) {
        return isPrivateIp(ipv4Part);
      }
      // Unrecognised form (hex notation) — block conservatively.
      return true;
    }

    return (
      lower === "::" || // unspecified
      lower === "::1" || // loopback
      lower.startsWith("fc") || // ULA fc00::/7
      lower.startsWith("fd") || // ULA fd00::/7 (fc00::/7 is fc + fd)
      // Link-local fe80::/10 covers fe80:: through febf::
      // First 10 bits = 1111 1110 10 → high byte 0xfe, next nibble 8–b
      (lower.startsWith("fe") &&
        lower.length >= 3 &&
        "89ab".includes(lower[2])) ||
      lower.startsWith("ff") // multicast ff00::/8
    );
  }

  return false;
}

/**
 * Resolves the hostname to IP addresses and validates that none of them
 * are private/internal.  Throws a UrlValidationError on any violation.
 *
 * NOTE: `new URL("http://[::1]/").hostname` returns `"[::1]"` (with brackets)
 * in Node.js.  We strip brackets before calling `isIP()` or `dns.lookup()`.
 */
async function assertHostnameIsSafe(rawHostname: string): Promise<void> {
  // Strip IPv6 brackets so isIP() and dns.lookup() receive the bare address.
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new UrlValidationError(
      `Requests to '${hostname}' are not permitted`,
      403,
    );
  }

  if (BLOCKED_METADATA_IPS.has(hostname)) {
    throw new UrlValidationError(
      "Requests to cloud metadata endpoints are not permitted",
      403,
    );
  }

  // If the hostname is already an IP literal, check it directly.
  if (isIP(hostname) !== 0) {
    if (isPrivateIp(hostname) || BLOCKED_METADATA_IPS.has(hostname)) {
      throw new UrlValidationError(
        "Requests to private or reserved IP addresses are not permitted",
        403,
      );
    }
    return;
  }

  // Resolve the hostname to IP addresses.
  let addresses: string[];
  try {
    const records = await dnsLookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new UrlValidationError(
      `Unable to resolve hostname '${hostname}'`,
      400,
    );
  }

  if (addresses.length === 0) {
    throw new UrlValidationError(
      `Hostname '${hostname}' did not resolve to any addresses`,
      400,
    );
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr) || BLOCKED_METADATA_IPS.has(addr)) {
      throw new UrlValidationError(
        "Requests to private or reserved IP addresses are not permitted",
        403,
      );
    }
  }
}

/**
 * Fully validates a URL for scraping:
 *  - Must be a valid URL.
 *  - Scheme must be http or https.
 *  - Hostname must resolve to a public IP address.
 *
 * Throws UrlValidationError on any violation.
 */
export async function validateUrl(urlString: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new UrlValidationError(`'${urlString}' is not a valid URL`, 400);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UrlValidationError(
      `Unsupported URL scheme '${parsed.protocol.replace(":", "")}'. Only http and https are allowed.`,
      400,
    );
  }

  await assertHostnameIsSafe(parsed.hostname);

  return parsed;
}
