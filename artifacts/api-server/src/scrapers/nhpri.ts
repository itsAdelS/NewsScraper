/**
 * NHPRIScraper — payer-specific scraper for Neighborhood Health Plan of
 * Rhode Island (NHPRI) properties.
 *
 * NHPRI is a Rhode Island Medicaid managed care organisation. Primary site
 * is nhpri.org. Currently inherits generic behaviour; add NHPRI-specific
 * extraction rules here as patterns are identified.
 */

import { GenericScraper } from "./generic.js";

export class NHPRIScraper extends GenericScraper {
  // Example future override:
  // protected postProcessContent(content: string, url: string): string {
  //   return content.replace(/© \d{4} NHPRI.*$/ms, "").trim();
  // }
}
