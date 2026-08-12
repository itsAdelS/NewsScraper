/**
 * AnthemScraper — payer-specific scraper for anthem.com properties.
 *
 * Currently inherits all generic behaviour.  Override postProcessContent()
 * here to add Anthem-specific extraction rules when needed in the future.
 */

import { GenericScraper } from "./generic.js";

export class AnthemScraper extends GenericScraper {
  // Example future override:
  // protected postProcessContent(content: string, url: string): string {
  //   // Strip Anthem-specific boilerplate footer text
  //   return content.replace(/© \d{4} Anthem.*$/ms, "").trim();
  // }
}
