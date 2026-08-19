#!/usr/bin/env python3
"""
PDF text extraction worker.

Reads a PDF from a file path supplied as a command-line argument (never
fetches URLs), extracts text using PyMuPDF, falls back to Tesseract OCR
for pages whose native text layer is weak, and writes a JSON result to
stdout.

Usage:
    python3 pdf_worker.py <pdf_file_path> <options_json>

options_json (all fields optional):
    {
      "max_pages":        100,
      "min_native_chars": 80,
      "min_native_words": 8,
      "ocr_dpi":          200
    }

Exit codes:
    0 — success (result JSON on stdout)
    1 — controlled extraction failure (error JSON on stdout)
"""

import sys
import os
import json
import re
import subprocess
import tempfile

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"error": "PyMuPDF not installed", "code": "import_error"}))
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------

DEFAULT_MAX_PAGES = 100
DEFAULT_MIN_NATIVE_CHARS = 80
DEFAULT_MIN_NATIVE_WORDS = 8
DEFAULT_OCR_DPI = 200

# Fraction of characters that must be printable ASCII/Latin for text to
# count as "readable" (catches garbled/encoding-garbage pages).
MIN_READABLE_FRACTION = 0.70

# Fraction of characters that must be alphanumeric.
MIN_ALNUM_FRACTION = 0.40


# ---------------------------------------------------------------------------
# Text quality helpers
# ---------------------------------------------------------------------------

def count_words(text: str) -> int:
    return len(re.findall(r"\b\w{2,}\b", text))


def is_readable(text: str) -> bool:
    """Return True when the text passes basic quality thresholds."""
    stripped = text.strip()
    if not stripped:
        return False
    total = len(stripped)
    printable = sum(
        1 for c in stripped
        if c.isprintable() or c in "\t\n\r"
    )
    alnum = sum(1 for c in stripped if c.isalnum())
    readable_frac = printable / total if total else 0
    alnum_frac = alnum / total if total else 0
    return readable_frac >= MIN_READABLE_FRACTION and alnum_frac >= MIN_ALNUM_FRACTION


def page_quality_ok(
    text: str,
    min_chars: int,
    min_words: int,
) -> bool:
    stripped = text.strip()
    if len(stripped) < min_chars:
        return False
    if count_words(stripped) < min_words:
        return False
    if not is_readable(stripped):
        return False
    return True


# ---------------------------------------------------------------------------
# Table extraction
# ---------------------------------------------------------------------------

def extract_tables_from_page(page: "fitz.Page") -> str:
    """
    Attempt to extract tables from a page using PyMuPDF's find_tables().
    Returns pipe-delimited rows appended as a block, or empty string.
    """
    try:
        tabs = page.find_tables()
        if not tabs or not tabs.tables:
            return ""
        lines = []
        for table in tabs.tables:
            rows = table.extract()
            if not rows:
                continue
            for row in rows:
                cells = [str(c).strip() if c is not None else "" for c in row]
                if any(cells):
                    lines.append(" | ".join(cells))
        return "\n".join(lines) if lines else ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------

def ocr_page(page: "fitz.Page", dpi: int) -> tuple[str, str | None]:
    """
    Render a single page to a PNG and run Tesseract CLI on it.
    Returns (text, error). A blank page is not itself an OCR failure.
    """
    tmp_png = None
    try:
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            tmp_png = f.name
            pix.save(tmp_png)

        result = subprocess.run(
            ["tesseract", tmp_png, "stdout", "--psm", "3", "-l", "eng"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            detail = (result.stderr or "").strip()
            return "", f"Tesseract failed: {detail[:300] or f'exit code {result.returncode}'}"
        return result.stdout.strip(), None
    except subprocess.TimeoutExpired:
        return "", "Tesseract timed out while processing a page"
    except FileNotFoundError:
        return "", "Tesseract is not installed or not available on PATH"
    except Exception as exc:
        return "", f"OCR failed: {exc}"
    finally:
        if tmp_png and os.path.exists(tmp_png):
            try:
                os.unlink(tmp_png)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Title derivation
# ---------------------------------------------------------------------------

def derive_title(doc: "fitz.Document") -> str:
    """
    Derive a document title from PDF metadata or the first meaningful line.
    """
    meta = doc.metadata or {}
    title = (meta.get("title") or "").strip()
    generic_titles = {"untitled", "document", "microsoft word", "pdf document"}
    if (
        title
        and len(title) > 2
        and title.lower().strip(" -_") not in generic_titles
        and len(title) <= 240
    ):
        return title

    # Fall back to first meaningful text line across all pages
    for page in doc:
        blocks = page.get_text("blocks")
        for block in blocks:
            # block: (x0, y0, x1, y1, text, block_no, block_type)
            if len(block) < 5:
                continue
            text = str(block[4]).strip()
            # Skip tiny/empty blocks
            if len(text) > 4 and count_words(text) >= 2:
                # Return first line only
                first_line = text.split("\n")[0].strip()
                if len(first_line) > 4:
                    return first_line
    return ""


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------

def extract(pdf_path: str, opts: dict) -> dict:
    max_pages = int(opts.get("max_pages", DEFAULT_MAX_PAGES))
    min_native_chars = int(opts.get("min_native_chars", DEFAULT_MIN_NATIVE_CHARS))
    min_native_words = int(opts.get("min_native_words", DEFAULT_MIN_NATIVE_WORDS))
    ocr_dpi = int(opts.get("ocr_dpi", DEFAULT_OCR_DPI))

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        return {"error": f"Cannot open PDF: {e}", "code": "corrupt"}

    # Check for encryption
    if doc.is_encrypted:
        doc.close()
        return {"error": "PDF is encrypted/password-protected", "code": "encrypted"}

    page_count = doc.page_count

    if page_count > max_pages:
        doc.close()
        return {
            "error": f"PDF has {page_count} pages, exceeds limit of {max_pages}",
            "code": "too_many_pages",
            "pageCount": page_count,
            "pdfSizeBytes": os.path.getsize(pdf_path),
        }

    pdf_size_bytes = os.path.getsize(pdf_path)
    title = derive_title(doc)

    pages_text = []       # final text for each page (native or OCR)
    native_pages = 0
    ocr_pages = 0
    ocr_used = False

    for page_num in range(page_count):
        page = doc[page_num]

        # --- Native text extraction ---
        native_text = page.get_text("text", sort=True).strip()
        table_text = extract_tables_from_page(page)

        combined_native = native_text
        if table_text:
            combined_native = (native_text + "\n" + table_text).strip()

        if page_quality_ok(combined_native, min_native_chars, min_native_words):
            pages_text.append(combined_native)
            native_pages += 1
        else:
            # --- OCR fallback ---
            ocr_text, ocr_error = ocr_page(page, ocr_dpi)
            if ocr_error:
                doc.close()
                return {
                    "error": f"OCR failed on page {page_num + 1}: {ocr_error}",
                    "code": "ocr_failed",
                    "pageCount": page_count,
                    "nativePages": native_pages,
                    "ocrPages": ocr_pages,
                    "ocrUsed": True,
                    "pdfSizeBytes": pdf_size_bytes,
                }
            if ocr_text:
                ocr_used = True
                ocr_pages += 1
                pages_text.append(ocr_text)
            else:
                # An empty page is valid. If it contains an image or a weak
                # text layer, though, an empty OCR result is a controlled
                # extraction failure rather than a silent success.
                if combined_native or page.get_images(full=True):
                    doc.close()
                    return {
                        "error": f"OCR produced no meaningful text for page {page_num + 1}",
                        "code": "ocr_failed",
                        "pageCount": page_count,
                        "nativePages": native_pages,
                        "ocrPages": ocr_pages,
                        "ocrUsed": True,
                        "pdfSizeBytes": pdf_size_bytes,
                    }
                pages_text.append("")

    doc.close()

    # Determine engine
    if native_pages == 0 and ocr_pages > 0:
        engine = "pdf-ocr"
    elif ocr_pages > 0:
        engine = "pdf-mixed"
    else:
        engine = "pdf-native"

    ordered_pages = [
        f"--- Page {page_number} ---\n{text}"
        for page_number, text in enumerate(pages_text, start=1)
        if text
    ]
    content = "\n\n".join(ordered_pages).strip()

    if not content:
        return {
            "error": "PDF contained no extractable text",
            "code": "no_text",
            "pageCount": page_count,
            "nativePages": native_pages,
            "ocrPages": ocr_pages,
            "ocrUsed": ocr_used,
            "pdfSizeBytes": pdf_size_bytes,
        }

    if not title:
        for page_text in pages_text:
            for line in page_text.splitlines():
                candidate = line.strip()
                if 4 < len(candidate) <= 240 and count_words(candidate) >= 2:
                    title = candidate
                    break
            if title:
                break

    return {
        "success": True,
        "title": title,
        "content": content,
        "engine": engine,
        "pageCount": page_count,
        "nativePages": native_pages,
        "ocrPages": ocr_pages,
        "ocrUsed": ocr_used,
        "pdfSizeBytes": pdf_size_bytes,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: pdf_worker.py <pdf_path> [opts_json]", "code": "usage"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    opts = {}
    if len(sys.argv) >= 3:
        try:
            opts = json.loads(sys.argv[2])
        except json.JSONDecodeError:
            pass

    result = extract(pdf_path, opts)
    print(json.dumps(result, ensure_ascii=False))
    # Controlled failures are valid JSON protocol responses. Process-level
    # failures (missing runtime, crash) still use a non-zero exit.
    sys.exit(0)
