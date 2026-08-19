import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workerPath = path.resolve(process.cwd(), "scripts/pdf_worker.py");
const defaultOptions = JSON.stringify({
  max_pages: 100,
  min_native_chars: 80,
  min_native_words: 8,
  ocr_dpi: 150,
});

interface WorkerResult {
  success?: boolean;
  error?: string;
  code?: string;
  title?: string;
  content?: string;
  engine?: string;
  pageCount?: number;
  nativePages?: number;
  ocrPages?: number;
  ocrUsed?: boolean;
  pdfSizeBytes?: number;
}

describe("PDF Python worker integration", () => {
  let fixtureDir: string;
  let pythonPath: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "payernews-pdf-tests-"));
    pythonPath = (await execFileAsync("which", ["python3"])).stdout.trim();

    const generator = String.raw`
import fitz
import os
import sys

out = sys.argv[1]
text = (
    "Payer Coverage Policy\n"
    "This medical policy explains eligibility, prior authorization, covered "
    "services, exclusions, and appeal rights for members and providers. "
)

native = fitz.open()
page = native.new_page()
page.insert_textbox(fitz.Rect(50, 50, 550, 500), text * 3, fontsize=12)
native.set_metadata({"title": "Payer Coverage Policy"})
native.save(os.path.join(out, "native.pdf"))
native.close()

source = fitz.open()
page = source.new_page()
page.insert_textbox(
    fitz.Rect(50, 50, 550, 500),
    "Scanned Coverage Notice\n" + text * 3,
    fontsize=14,
)
pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), colorspace=fitz.csGRAY)
image = pix.tobytes("png")
source.close()

scanned = fitz.open()
page = scanned.new_page()
page.insert_image(page.rect, stream=image)
scanned.save(os.path.join(out, "scanned.pdf"))
scanned.close()

mixed = fitz.open()
page = mixed.new_page()
page.insert_textbox(fitz.Rect(50, 50, 550, 500), text * 3, fontsize=12)
page = mixed.new_page()
page.insert_image(page.rect, stream=image)
mixed.save(os.path.join(out, "mixed.pdf"))
mixed.close()

many = fitz.open()
for _ in range(3):
    page = many.new_page()
    page.insert_textbox(fitz.Rect(50, 50, 550, 500), text * 3, fontsize=12)
many.save(os.path.join(out, "many-pages.pdf"))
many.close()

encrypted = fitz.open()
page = encrypted.new_page()
page.insert_textbox(fitz.Rect(50, 50, 550, 500), text * 3, fontsize=12)
encrypted.save(
    os.path.join(out, "encrypted.pdf"),
    encryption=fitz.PDF_ENCRYPT_AES_256,
    owner_pw="owner-password",
    user_pw="user-password",
)
encrypted.close()
`;

    await execFileAsync(pythonPath, ["-c", generator, fixtureDir]);
    await writeFile(path.join(fixtureDir, "corrupt.pdf"), "%PDF-not-a-real-document");
  }, 30_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  async function runWorker(
    filename: string,
    options = defaultOptions,
    env = process.env,
  ): Promise<WorkerResult> {
    const { stdout } = await execFileAsync(
      pythonPath,
      [workerPath, path.join(fixtureDir, filename), options],
      { env, maxBuffer: 20 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as WorkerResult;
  }

  it("extracts native PDF text and metadata", async () => {
    const result = await runWorker("native.pdf");

    expect(result).toMatchObject({
      success: true,
      title: "Payer Coverage Policy",
      engine: "pdf-native",
      pageCount: 1,
      nativePages: 1,
      ocrPages: 0,
      ocrUsed: false,
    });
    expect(result.content).toContain("--- Page 1 ---");
    expect(result.content).toContain("prior authorization");
    expect(result.pdfSizeBytes).toBeGreaterThan(0);
  });

  it("OCRs an image-only scanned PDF", async () => {
    const result = await runWorker("scanned.pdf");

    expect(result).toMatchObject({
      success: true,
      engine: "pdf-ocr",
      pageCount: 1,
      nativePages: 0,
      ocrPages: 1,
      ocrUsed: true,
    });
    expect(result.content).toMatch(/Scanned Coverage Notice/i);
  }, 30_000);

  it("preserves page order for a mixed native and scanned PDF", async () => {
    const result = await runWorker("mixed.pdf");

    expect(result).toMatchObject({
      success: true,
      engine: "pdf-mixed",
      pageCount: 2,
      nativePages: 1,
      ocrPages: 1,
      ocrUsed: true,
    });
    expect(result.content?.indexOf("--- Page 1 ---")).toBeLessThan(
      result.content?.indexOf("--- Page 2 ---") ?? -1,
    );
  }, 30_000);

  it("rejects over-page-limit, encrypted, and corrupt PDFs predictably", async () => {
    const [tooMany, encrypted, corrupt] = await Promise.all([
      runWorker(
        "many-pages.pdf",
        JSON.stringify({ ...JSON.parse(defaultOptions), max_pages: 2 }),
      ),
      runWorker("encrypted.pdf"),
      runWorker("corrupt.pdf"),
    ]);

    expect(tooMany).toMatchObject({ code: "too_many_pages", pageCount: 3 });
    expect(encrypted).toMatchObject({ code: "encrypted" });
    expect(corrupt).toMatchObject({ code: "corrupt" });
  });

  it("returns a controlled error when OCR is unavailable", async () => {
    const result = await runWorker("scanned.pdf", defaultOptions, {
      ...process.env,
      PATH: "/nonexistent",
    });

    expect(result.success).not.toBe(true);
    expect(result.code).toBe("ocr_failed");
    expect(result.error).toMatch(/Tesseract is not installed/i);
  });
});