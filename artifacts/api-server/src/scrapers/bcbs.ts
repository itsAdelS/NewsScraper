/**
 * BCBSScraper — payer-specific scraper for Blue Cross Blue Shield properties.
 *
 * BCBS operates as a federation of independent regional plans. This scraper
 * covers the national association site (bcbs.com) and the major regional
 * plan domains. All currently inherit generic behaviour; add per-plan
 * overrides in postProcessContent() as extraction patterns emerge.
 */

import { GenericScraper } from "./generic.js";

export class BCBSScraper extends GenericScraper {
  // Example future override:
  // protected postProcessContent(content: string, url: string): string {
  //   return content.replace(/Find a Doctor.*$/ms, "").trim();
  // }
}
