/**
 * PDF scraper — downloads a PDF, writes it to a restricted temp file,
 * runs the Python worker (pdf_worker.py) via execFile (no shell), and
 * returns structured text content.
 *
 * The Python worker never fetches URLs — it only reads the file path
 * passed as a CLI argument.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  safeFetchBinary,
  type SafeFetchBinaryResult,
} from "../utils/safe-fetch.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { pdfPool, PdfPoolFullError, PdfTimeoutError } from "./pdf-pool.js";
import type { EngineResult, ScraperEngine } from "./types.js";

/** Resolve correctly both from source during tests and from dist/index.mjs. */
function workerScriptPath(): string {
  const candidates = [
    fileURLToPath(new URL("../scripts/pdf_worker.py", import.meta.url)),
    fileURLToPath(new URL("../../scripts/pdf_worker.py", import.meta.url)),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("PDF worker script is missing");
  }
  return found;
}

/** Magic bytes that identify a PDF file (%PDF-). */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

/**
 * Return true when the buffer starts with the PDF magic bytes (%PDF-).
 */
export function hasPdfMagic(buf: Buffer): boolean {
  return buf.subarray(0, 1024).indexOf(PDF_MAGIC) >= 0;
}

/**
 * Return true when a Content-Type value indicates a PDF.
 * Handles "application/pdf" and "application/x-pdf".
 */
export function isPdfContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/pdf") || lower.includes("application/x-pdf");
}

/**
 * Return true when the URL path ends with ".pdf" (case-insensitive).
 * This is a hint only — the actual body type still takes precedence.
 */
export function hasPdfExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * Detect whether a fetch response is a PDF.
 *
 * Rules (in priority order):
 *  1. If the body starts with %PDF- magic bytes → PDF.
 *  2. If the Content-Type is application/pdf → PDF.
 *  3. If neither of the above but the URL ends with .pdf → treat as HTML
 *     (server is returning HTML for a .pdf URL — follow HTML path).
 *
 * Returns true only when we are confident it is a real PDF binary.
 */
export function detectPdf(
  body: Buffer,
  contentType: string | undefined,
  url: string,
): boolean {
  // Magic bytes are authoritative — ignore hints.
  if (hasPdfMagic(body)) return true;

  const lowerContentType = contentType?.toLowerCase() ?? "";
  const prefix = body.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  const looksLikeHtml =
    lowerContentType.includes("text/html") ||
    prefix.includes("<!doctype html") ||
    prefix.includes("<html");
  if (looksLikeHtml) return false;

  // Content-Type is strongly indicative.
  if (isPdfContentType(contentType)) return true;

  // The extension is a final hint only after excluding an actual HTML response.
  return hasPdfExtension(url);
}

/** Controlled errors that come back from the Python worker. */
type WorkerErrorCode =
  | "encrypted"
  | "corrupt"
  | "too_many_pages"
  | "import_error"
  | "usage"
  | string;

interface WorkerSuccess {
  success: true;
  title: string;
  content: string;
  engine: ScraperEngine;
  pageCount: number;
  nativePages: number;
  ocrPages: number;
  ocrUsed: boolean;
  pdfSizeBytes: number;
}

interface WorkerFailure {
  success?: false;
  error: string;
  code: WorkerErrorCode;
  pageCount?: number;
  nativePages?: number;
  ocrPages?: number;
  ocrUsed?: boolean;
  pdfSizeBytes?: number;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

function runWorker(
  pdfPath: string,
  optionsJson: string,
  timeoutMs: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = 20 * 1024 * 1024;
    const detached = process.platform !== "win32";
    const child = spawn(
      "python3",
      [workerScriptPath(), pdfPath, optionsJson],
      {
        shell: false,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const killWorker = (): void => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killWorker();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        killWorker();
        finishError(new Error("PDF worker output exceeded the safety limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (timedOut) {
        finishError(new PdfTimeoutError(timeoutMs));
        return;
      }

      const output = Buffer.concat(stdout).toString("utf8").trim();
      try {
        const parsed = JSON.parse(output) as WorkerResult;
        settled = true;
        resolve(parsed);
      } catch {
        const diagnostics = Buffer.concat(stderr).toString("utf8").trim();
        finishError(
          new Error(
            diagnostics
              ? `PDF worker exited ${code ?? "unexpectedly"}: ${diagnostics.slice(0, 500)}`
              : `PDF worker exited ${code ?? "unexpectedly"} without valid JSON`,
          ),
        );
      }
    });
  });
}

/** Derive a fallback title from the final URL filename. */
function titleFromUrl(finalUrl: string): string {
  try {
    const p = new URL(finalUrl).pathname;
    const base = path.basename(p, ".pdf");
    // Replace URL-encoding and dashes/underscores with spaces.
    return decodeURIComponent(base).replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Scrape a URL that is known (or suspected) to be a PDF.
 *
 * Runs inside the PDF pool for bounded concurrency.
 * Maps worker error codes to structured EngineResult failures:
 *   - encrypted / corrupt / too_many_pages → 422
 *   - pool full → throws PdfPoolFullError (route maps to 503)
 *   - timeout   → throws PdfTimeoutError (route maps to 504)
 */
export async function scrapePdf(
  url: string,
  requestId: string,
  prefetched?: SafeFetchBinaryResult,
): Promise<EngineResult> {
  const maxPdfBytes = config.maxPdfSizeMb * 1024 * 1024;
  const timeoutMs = config.pdfOcrTimeoutSeconds * 1000;

  logger.info({ requestId, url }, "PDF scraper: starting");

  // ── Step 1: Download bytes ──────────────────────────────────────────────────
  let fetchResult: Awaited<ReturnType<typeof safeFetchBinary>>;
  try {
    fetchResult =
      prefetched ??
      await safeFetchBinary(url, {
        maxBytes: maxPdfBytes,
        timeoutMs: config.maxScraperTimeoutMs,
        accept: "application/pdf,*/*;q=0.8",
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ requestId, url, error: msg }, "PDF scraper: fetch failed");
    if (msg.toLowerCase().includes("timed out")) {
      throw new PdfTimeoutError(config.maxScraperTimeoutMs, "download");
    }
    return {
      success: false,
      finalUrl: "",
      scraperUsed: "",
      title: "",
      content: "",
      statusCode: 0,
      error: msg,
    };
  }

  const { body, finalUrl, statusCode, contentType, truncatedBody } = fetchResult;

  logger.info(
    {
      requestId,
      finalUrl,
      statusCode,
      contentType,
      bodyBytes: body.length,
      truncatedBody,
    },
    "PDF scraper: fetch complete",
  );

  if (statusCode < 200 || statusCode >= 300) {
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: `Target server returned HTTP ${statusCode}`,
    };
  }

  if (truncatedBody) {
    logger.warn(
      { requestId, url, bodyBytes: body.length, maxPdfBytes },
      "PDF scraper: body truncated — likely exceeds size limit",
    );
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: `PDF exceeds maximum size (${config.maxPdfSizeMb} MB)`,
      pdfSizeBytes: body.length,
    };
  }

  if (!hasPdfMagic(body)) {
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: "Response is not a valid PDF document",
      pdfSizeBytes: body.length,
    };
  }

  // ── Step 2: Write temp file with restrictive permissions ────────────────────
  let tmpFile: string | null = null;
  try {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-scraper-"));
    tmpFile = path.join(tmpDir, "document.pdf");
    await fs.writeFile(tmpFile, body, { mode: 0o600 });
    logger.debug({ requestId, tmpFile, bytes: body.length }, "PDF scraper: wrote temp file");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ requestId, error: msg }, "PDF scraper: failed to write temp file");
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: `Failed to create temp file: ${msg}`,
    };
  }

  // ── Step 3: Run Python worker via PDF pool ─────────────────────────────────
  const workerOpts = JSON.stringify({
    max_pages: config.maxPdfPages,
    min_native_chars: config.pdfMinNativeChars,
    min_native_words: config.pdfMinNativeWords,
    ocr_dpi: config.pdfOcrDpi,
  });

  let workerResult: WorkerResult;
  try {
    workerResult = await pdfPool.run(async () => {
      logger.debug({ requestId, tmpFile }, "PDF scraper: running Python worker");

      return runWorker(tmpFile!, workerOpts, timeoutMs);
    }, timeoutMs);
  } catch (err) {
    // Re-throw pool/timeout errors — the route handler maps these.
    if (err instanceof PdfPoolFullError || err instanceof PdfTimeoutError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ requestId, error: msg }, "PDF scraper: worker failed");
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: `PDF extraction failed: ${msg}`,
    };
  } finally {
    // Always clean up the temp file.
    if (tmpFile) {
      const dir = path.dirname(tmpFile);
      fs.rm(dir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup — log but don't throw.
        logger.warn({ tmpFile }, "PDF scraper: temp cleanup failed");
      });
    }
  }

  // ── Step 4: Map worker result to EngineResult ──────────────────────────────
  if (!workerResult.success) {
    const failure = workerResult as WorkerFailure;
    logger.warn(
      { requestId, code: failure.code, error: failure.error },
      "PDF scraper: controlled extraction failure",
    );
    return {
      success: false,
      finalUrl,
      scraperUsed: "",
      title: "",
      content: "",
      statusCode,
      error: failure.error,
      ocrUsed: failure.ocrUsed,
      pageCount: failure.pageCount,
      nativePages: failure.nativePages,
      ocrPages: failure.ocrPages,
      pdfSizeBytes: failure.pdfSizeBytes ?? body.length,
    };
  }

  const ok = workerResult as WorkerSuccess;

  // Node-side title fallback: use final URL filename if Python returned empty.
  const title = ok.title || titleFromUrl(finalUrl);

  logger.info(
    {
      requestId,
      finalUrl,
      engine: ok.engine,
      pageCount: ok.pageCount,
      nativePages: ok.nativePages,
      ocrPages: ok.ocrPages,
      ocrUsed: ok.ocrUsed,
      contentLength: ok.content.length,
    },
    "PDF scraper: extraction complete",
  );

  return {
    success: ok.content.length > 0,
    finalUrl,
    scraperUsed: ok.engine,
    title,
    content: ok.content,
    statusCode,
    error: ok.content.length === 0 ? "PDF contained no extractable text" : undefined,
    ocrUsed: ok.ocrUsed,
    pageCount: ok.pageCount,
    nativePages: ok.nativePages,
    ocrPages: ok.ocrPages,
    pdfSizeBytes: ok.pdfSizeBytes,
  };
}
