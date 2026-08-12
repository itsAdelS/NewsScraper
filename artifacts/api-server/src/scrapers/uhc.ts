/**
 * UHCScraper — payer-specific scraper for UnitedHealth Group properties
 * (uhcprovider.com, unitedhealthcareonline.com, uhc.com, etc.).
 *
 * Currently inherits all generic behaviour.  Override postProcessContent()
 * here to add UHC-specific extraction rules when needed in the future.
 */

import { GenericScraper } from "./generic.js";

export class UHCScraper extends GenericScraper {
  // Placeholder for UHC-specific extraction logic.
}
