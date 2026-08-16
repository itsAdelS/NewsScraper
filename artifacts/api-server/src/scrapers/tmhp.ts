/**
 * TMHPScraper — payer-specific scraper for Texas Medicaid & Healthcare
 * Partnership (TMHP) properties.
 *
 * TMHP administers Texas Medicaid on behalf of HHSC. The primary provider
 * portal is tmhp.com. Currently inherits generic behaviour; add TMHP-specific
 * extraction rules here as patterns are identified.
 */

import { GenericScraper } from "./generic.js";

export class TMHPScraper extends GenericScraper {
  // Example future override:
  // protected postProcessContent(content: string, url: string): string {
  //   return content.replace(/Texas Medicaid.*footer/ms, "").trim();
  // }
}
