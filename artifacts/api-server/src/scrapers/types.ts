/** HTTP status codes used in scrape responses. */
export type ScrapeHttpStatus = 200 | 400 | 401 | 403 | 404 | 422 | 500 | 504;

/** Which low-level mechanism successfully extracted content. */
export type ScraperEngine = "static" | "playwright" | "";

/** Internal result returned by individual scraper engines. */
export interface EngineResult {
  /** Whether meaningful content was successfully extracted. */
  success: boolean;
  /** Final URL after redirects. */
  finalUrl: string;
  /** Which engine produced this result. */
  scraperUsed: ScraperEngine;
  /** Page title (may be empty). */
  title: string;
  /** Cleaned, meaningful text content. */
  content: string;
  /** HTTP status code returned by the target server. */
  statusCode: number;
  /** Human-readable error message when success is false. */
  error?: string;
}

/** JSON body for POST /api/scrape */
export interface ScrapeRequestBody {
  url: string;
  route?: string;
}

/** JSON body returned for every POST /api/scrape call (success and failure). */
export interface ScrapeResponseBody {
  success: boolean;
  url: string;
  finalUrl: string;
  route: string;
  scraperUsed: ScraperEngine;
  title: string;
  content: string;
  contentLength: number;
  statusCode: number;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

/** Abstract interface every scraper must implement. */
export interface IScraper {
  scrape(url: string, requestId: string): Promise<EngineResult>;
}
