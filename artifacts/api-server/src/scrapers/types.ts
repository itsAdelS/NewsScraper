/** HTTP status codes used in scrape responses. */
export type ScrapeHttpStatus = 200 | 400 | 401 | 403 | 404 | 422 | 500 | 503 | 504;

/**
 * Which low-level mechanism successfully extracted content.
 * HTML engines: "static" | "playwright" | ""
 * PDF engines:  "pdf-native" | "pdf-ocr" | "pdf-mixed"
 */
export type ScraperEngine =
  | "static"
  | "playwright"
  | "pdf-native"
  | "pdf-ocr"
  | "pdf-mixed"
  | "";

/** Whether the scraped document was HTML or a PDF. */
export type DocumentType = "html" | "pdf";

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

  // ── Optional PDF metadata ────────────────────────────────────────────────────

  /** Whether OCR was used during extraction. */
  ocrUsed?: boolean;
  /** Total number of pages in the PDF. */
  pageCount?: number;
  /** Number of pages extracted via native text layer. */
  nativePages?: number;
  /** Number of pages that required OCR. */
  ocrPages?: number;
  /** Raw file size of the PDF in bytes. */
  pdfSizeBytes?: number;
}

/** JSON body for POST /api/scrape */
export interface ScrapeRequestBody {
  url: string;
  route?: string;
}

/** A previously downloaded HTML response that can be reused by the static engine. */
export interface FetchedHtmlPage {
  html: string;
  finalUrl: string;
  statusCode: number;
  contentType: string | undefined;
  truncatedBody: boolean;
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

  // ── Document type and optional PDF metadata ──────────────────────────────────

  /** Whether the source document was HTML or a PDF. */
  documentType?: DocumentType;
  /** Whether OCR was used during PDF extraction. */
  ocrUsed?: boolean;
  /** Total number of pages in the PDF. */
  pageCount?: number;
  /** Number of pages extracted via native text layer. */
  nativePages?: number;
  /** Number of pages that required OCR. */
  ocrPages?: number;
  /** Raw file size of the PDF in bytes. */
  pdfSizeBytes?: number;

}

/** Abstract interface every scraper must implement. */
export interface IScraper {
  scrape(
    url: string,
    requestId: string,
    prefetched?: FetchedHtmlPage,
  ): Promise<EngineResult>;
}
