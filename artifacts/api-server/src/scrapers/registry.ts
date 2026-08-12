/**
 * Scraper registry — maps route names to scraper instances and provides
 * automatic domain-based route detection.
 */

import { GenericScraper } from "./generic.js";
import { AnthemScraper } from "./anthem.js";
import { AetnaScraper } from "./aetna.js";
import { UHCScraper } from "./uhc.js";
import { CignaScraper } from "./cigna.js";
import type { IScraper } from "./types.js";

/** Supported named routes. */
export type ScraperRoute = "generic" | "anthem" | "aetna" | "uhc" | "cigna";

/** All valid route names. */
export const VALID_ROUTES: ReadonlySet<string> = new Set<ScraperRoute>([
  "generic",
  "anthem",
  "aetna",
  "uhc",
  "cigna",
]);

/** Map of route names to their scraper instances (lazily initialised). */
const SCRAPERS: Record<ScraperRoute, IScraper> = {
  generic: new GenericScraper(),
  anthem: new AnthemScraper(),
  aetna: new AetnaScraper(),
  uhc: new UHCScraper(),
  cigna: new CignaScraper(),
};

/**
 * Domain-to-route mapping.
 *
 * Each entry is matched against the request URL's hostname:
 *   - Exact match: hostname === entry
 *   - Subdomain match: hostname ends with "." + entry
 *
 * Keep this list easy to extend — one line per domain family.
 */
const DOMAIN_ROUTES: ReadonlyArray<[domain: string, route: ScraperRoute]> = [
  // Anthem / Elevance Health
  ["anthem.com", "anthem"],
  ["elevancehealth.com", "anthem"],
  ["anthembluecross.com", "anthem"],

  // Aetna / CVS Health
  ["aetna.com", "aetna"],
  ["cvs.com", "aetna"],

  // UnitedHealth Group
  ["uhc.com", "uhc"],
  ["uhcprovider.com", "uhc"],
  ["unitedhealthcareonline.com", "uhc"],
  ["unitedhealthcare.com", "uhc"],
  ["myuhc.com", "uhc"],
  ["optum.com", "uhc"],

  // Cigna / Evernorth
  ["cigna.com", "cigna"],
  ["evernorth.com", "cigna"],
  ["cignaforhcp.com", "cigna"],
];

/**
 * Detects the appropriate route from a URL's hostname.
 * Returns the matched route or "generic" if no payer is recognised.
 */
export function detectRouteFromUrl(urlString: string): ScraperRoute {
  let hostname: string;
  try {
    hostname = new URL(urlString).hostname.toLowerCase();
  } catch {
    return "generic";
  }

  for (const [domain, route] of DOMAIN_ROUTES) {
    if (hostname === domain || hostname.endsWith("." + domain)) {
      return route;
    }
  }

  return "generic";
}

/**
 * Resolves the effective route:
 *  1. Use the explicitly supplied route if it is valid.
 *  2. Otherwise detect from the URL domain.
 *  3. Default to "generic".
 */
export function resolveRoute(
  requestedRoute: string | undefined,
  url: string,
): ScraperRoute {
  if (requestedRoute && VALID_ROUTES.has(requestedRoute)) {
    return requestedRoute as ScraperRoute;
  }
  return detectRouteFromUrl(url);
}

/** Returns the scraper instance for a given route. */
export function getScraper(route: ScraperRoute): IScraper {
  return SCRAPERS[route];
}
