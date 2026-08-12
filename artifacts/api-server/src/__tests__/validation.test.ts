/**
 * Unit tests for URL validation and SSRF protection.
 *
 * Tests cases:
 *  1. Missing URL (handled at route level — tested in scrape.test.ts)
 *  2. Invalid URL
 *  3. Unsupported URL scheme
 * 13. localhost SSRF attempt
 * 14. Private IP SSRF attempt
 * 15. Domain-based route selection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateUrl,
  isPrivateIp,
  UrlValidationError,
} from "../utils/validation.js";
import { detectRouteFromUrl, resolveRoute } from "../scrapers/registry.js";

// Mock dns/promises so tests don't make real DNS calls.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup } from "node:dns/promises";
const mockLookup = vi.mocked(lookup);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: resolve to a public IP.
  mockLookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as never);
});

// ─── isPrivateIp ─────────────────────────────────────────────────────────────

describe("isPrivateIp", () => {
  it("returns true for 127.0.0.1 (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("returns true for 127.x.x.x range", () => {
    expect(isPrivateIp("127.0.0.10")).toBe(true);
  });

  it("returns true for 10.x.x.x (private)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
  });

  it("returns true for 172.16.x.x (private)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });

  it("returns true for 172.31.x.x (private)", () => {
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("returns false for 172.32.x.x (public)", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("returns true for 192.168.x.x (private)", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("returns true for 169.254.x.x (link-local)", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("returns true for 100.64.x.x (CGNAT)", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("returns false for a public IP", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("returns true for ::1 (IPv6 loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("returns true for :: (IPv6 unspecified)", () => {
    expect(isPrivateIp("::")).toBe(true);
  });

  it("returns true for fd00:: (ULA)", () => {
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  it("returns true for fc00:: (ULA fc00::/7)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
  });

  it("returns true for fe80:: (IPv6 link-local, start of /10 range)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("returns true for fe90:: (IPv6 link-local, inside /10 range)", () => {
    expect(isPrivateIp("fe90::1")).toBe(true);
  });

  it("returns true for fea0:: (IPv6 link-local, inside /10 range)", () => {
    expect(isPrivateIp("fea0::1")).toBe(true);
  });

  it("returns true for feb0:: (IPv6 link-local, inside /10 range)", () => {
    expect(isPrivateIp("feb0::1")).toBe(true);
  });

  it("returns true for febf:: (IPv6 link-local, end of /10 range)", () => {
    expect(isPrivateIp("febf::1")).toBe(true);
  });

  it("returns false for fec0:: (IPv6 NOT link-local, outside /10 range)", () => {
    // fec0::/10 was previously site-local but is deprecated and unassigned;
    // it IS a global unicast space in modern allocation.
    expect(isPrivateIp("fec0::1")).toBe(false);
  });

  it("returns true for ff00:: (IPv6 multicast)", () => {
    expect(isPrivateIp("ff00::1")).toBe(true);
  });

  it("returns true for ffff:: (IPv6 multicast)", () => {
    expect(isPrivateIp("ffff::1")).toBe(true);
  });

  it("returns true for ::ffff:192.168.1.1 (IPv4-mapped private)", () => {
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
  });

  it("returns true for ::ffff:10.0.0.1 (IPv4-mapped private)", () => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("returns true for ::ffff:169.254.169.254 (IPv4-mapped metadata)", () => {
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
  });

  it("returns false for ::ffff:93.184.216.34 (IPv4-mapped public)", () => {
    expect(isPrivateIp("::ffff:93.184.216.34")).toBe(false);
  });
});

// ─── validateUrl ─────────────────────────────────────────────────────────────

describe("validateUrl — invalid URLs", () => {
  // Test case 2: Invalid URL
  it("rejects a non-URL string", async () => {
    await expect(validateUrl("not-a-url")).rejects.toThrow(UrlValidationError);
    await expect(validateUrl("not-a-url")).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("rejects an empty string", async () => {
    await expect(validateUrl("")).rejects.toThrow(UrlValidationError);
  });
});

describe("validateUrl — unsupported schemes", () => {
  // Test case 3: Unsupported URL scheme
  it("rejects file:// scheme", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(
      UrlValidationError,
    );
    await expect(validateUrl("file:///etc/passwd")).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("rejects ftp:// scheme", async () => {
    await expect(validateUrl("ftp://example.com/file")).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("rejects javascript: scheme", async () => {
    await expect(validateUrl("javascript:alert(1)")).rejects.toThrow(
      UrlValidationError,
    );
  });
});

describe("validateUrl — IPv6 literal handling", () => {
  it("rejects http://[::1]/ (IPv6 loopback literal)", async () => {
    await expect(validateUrl("http://[::1]/")).rejects.toThrow(UrlValidationError);
    await expect(validateUrl("http://[::1]/")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("rejects http://[fe80::1]/ (IPv6 link-local literal)", async () => {
    await expect(validateUrl("http://[fe80::1]/")).rejects.toThrow(UrlValidationError);
    await expect(validateUrl("http://[fe80::1]/")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("rejects http://[feb0::1]/ (IPv6 link-local /10 range)", async () => {
    await expect(validateUrl("http://[feb0::1]/")).rejects.toThrow(UrlValidationError);
  });

  it("rejects http://[fc00::1]/ (IPv6 ULA literal)", async () => {
    await expect(validateUrl("http://[fc00::1]/")).rejects.toThrow(UrlValidationError);
    await expect(validateUrl("http://[fc00::1]/")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("rejects http://[ff00::1]/ (IPv6 multicast literal)", async () => {
    await expect(validateUrl("http://[ff00::1]/")).rejects.toThrow(UrlValidationError);
  });

  it("accepts a public IPv6 address literal when DNS resolves it", async () => {
    // new URL("http://[2606:2800:220:1:248:1893:25c8:1946]/").hostname === "[2606:...]"
    // validateUrl must strip the brackets before isIP() / dns lookup.
    mockLookup.mockResolvedValue([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ] as never);
    const result = await validateUrl(
      "http://[2606:2800:220:1:248:1893:25c8:1946]/page",
    );
    expect(result.hostname).toBe("[2606:2800:220:1:248:1893:25c8:1946]");
  });
});

describe("validateUrl — SSRF protection (test cases 13 & 14)", () => {
  // Test case 13: localhost SSRF attempt
  it("rejects http://localhost", async () => {
    await expect(validateUrl("http://localhost/admin")).rejects.toThrow(
      UrlValidationError,
    );
    await expect(validateUrl("http://localhost/admin")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  // Test case 13 (continued): 127.0.0.1 SSRF attempt
  it("rejects http://127.0.0.1", async () => {
    await expect(validateUrl("http://127.0.0.1/admin")).rejects.toThrow(
      UrlValidationError,
    );
    await expect(validateUrl("http://127.0.0.1/admin")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  // Test case 14: Private IP SSRF attempt
  it("rejects http://10.0.0.1 (private IP)", async () => {
    await expect(validateUrl("http://10.0.0.1/internal")).rejects.toThrow(
      UrlValidationError,
    );
    await expect(
      validateUrl("http://10.0.0.1/internal"),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("rejects http://192.168.1.1 (private IP)", async () => {
    await expect(validateUrl("http://192.168.1.1/")).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("rejects http://169.254.169.254 (metadata endpoint)", async () => {
    await expect(validateUrl("http://169.254.169.254/")).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("rejects a hostname that resolves to a private IP", async () => {
    mockLookup.mockResolvedValue([
      { address: "192.168.1.100", family: 4 },
    ] as never);
    await expect(
      validateUrl("https://internal.example.com/page"),
    ).rejects.toThrow(UrlValidationError);
    await expect(
      validateUrl("https://internal.example.com/page"),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("accepts a valid public URL", async () => {
    const result = await validateUrl("https://example.com/page");
    expect(result.hostname).toBe("example.com");
  });
});

// ─── Route detection (test case 15) ──────────────────────────────────────────

describe("detectRouteFromUrl — domain-based route selection (test case 15)", () => {
  it("detects anthem from anthem.com", () => {
    expect(detectRouteFromUrl("https://anthem.com/policy")).toBe("anthem");
  });

  it("detects anthem from subdomain of anthem.com", () => {
    expect(detectRouteFromUrl("https://providers.anthem.com/")).toBe("anthem");
  });

  it("detects aetna from aetna.com", () => {
    expect(detectRouteFromUrl("https://aetna.com/policy")).toBe("aetna");
  });

  it("detects uhc from uhcprovider.com", () => {
    expect(detectRouteFromUrl("https://uhcprovider.com/policies")).toBe("uhc");
  });

  it("detects uhc from unitedhealthcareonline.com", () => {
    expect(
      detectRouteFromUrl("https://unitedhealthcareonline.com/page"),
    ).toBe("uhc");
  });

  it("detects cigna from cigna.com", () => {
    expect(detectRouteFromUrl("https://cigna.com/policy")).toBe("cigna");
  });

  it("detects cigna from evernorth.com", () => {
    expect(detectRouteFromUrl("https://evernorth.com/policy")).toBe("cigna");
  });

  it("falls back to generic for unknown domain", () => {
    expect(detectRouteFromUrl("https://randominsurer.com/")).toBe("generic");
  });

  it("uses explicit route over domain detection", () => {
    // uhc.com would normally map to uhc, but explicit route wins.
    expect(resolveRoute("anthem", "https://uhc.com/policy")).toBe("anthem");
  });

  it("ignores invalid explicit route and falls back to domain detection", () => {
    expect(resolveRoute("unknown_payer", "https://aetna.com/")).toBe("aetna");
  });

  it("defaults to generic when no route and unknown domain", () => {
    expect(resolveRoute(undefined, "https://somerandompayer.com/")).toBe("generic");
  });
});
