/**
 * Unit tests for HTML → text extraction and content quality detection.
 */

import { describe, it, expect } from "vitest";
import { extractText, extractTitle, isMeaningful } from "../utils/cleanup.js";

describe("extractTitle", () => {
  it("extracts the page title", () => {
    const html = "<html><head><title>Medical Policy Update</title></head><body></body></html>";
    expect(extractTitle(html)).toBe("Medical Policy Update");
  });

  it("returns empty string when no title", () => {
    expect(extractTitle("<html><body>content</body></html>")).toBe("");
  });
});

describe("extractText", () => {
  it("strips script and style tags", () => {
    const html = `
      <html><body>
        <script>alert('xss')</script>
        <style>.foo { color: red; }</style>
        <p>Real content here</p>
      </body></html>
    `;
    const text = extractText(html);
    expect(text).toContain("Real content here");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
  });

  it("converts a table to pipe-delimited text", () => {
    const html = `
      <html><body>
        <table>
          <tr><th>CPT Code</th><th>Description</th><th>Effective Date</th></tr>
          <tr><td>12345</td><td>Office Visit</td><td>2026-09-01</td></tr>
          <tr><td>67890</td><td>Lab Test</td><td>2026-09-01</td></tr>
        </table>
      </body></html>
    `;
    const text = extractText(html);
    expect(text).toContain("CPT Code");
    expect(text).toContain("12345");
    expect(text).toContain("|");
    expect(text).toContain("2026-09-01");
  });

  it("preserves headings on their own lines", () => {
    const html = `
      <html><body>
        <h1>Medical Policy Update</h1>
        <p>Effective September 1, prior authorization will be required.</p>
      </body></html>
    `;
    const text = extractText(html);
    expect(text).toContain("Medical Policy Update");
    expect(text).toContain("Effective September 1");
  });

  it("removes navigation elements", () => {
    const html = `
      <html><body>
        <nav>Home | About | Contact | Menu Item 1 | Menu Item 2</nav>
        <main><p>This is the payer policy content.</p></main>
      </body></html>
    `;
    const text = extractText(html);
    expect(text).toContain("payer policy content");
    expect(text).not.toContain("Menu Item 1");
  });

  it("normalises excessive whitespace", () => {
    const html = `
      <html><body>
        <p>Line   one</p>
        <p>Line   two</p>
      </body></html>
    `;
    const text = extractText(html);
    // Should not have 3+ consecutive blank lines
    expect(text).not.toMatch(/\n{3,}/);
    // Should not have multi-space runs
    expect(text).not.toMatch(/ {2,}/);
  });
});

describe("isMeaningful", () => {
  const minChars = 200;

  it("returns false for content below minimum char threshold", () => {
    expect(isMeaningful("Too short", minChars)).toBe(false);
  });

  it("returns true for sufficiently long content", () => {
    const content = "Useful payer policy content. ".repeat(20);
    expect(isMeaningful(content, minChars)).toBe(true);
  });

  it("returns false for short access-denied pages", () => {
    const accessDenied = "Access Denied. You do not have permission to access this page.";
    expect(isMeaningful(accessDenied, minChars)).toBe(false);
  });

  it("returns false for CAPTCHA/bot protection pages", () => {
    const captcha = "Verify you are human. Please complete the CAPTCHA challenge.";
    expect(isMeaningful(captcha, minChars)).toBe(false);
  });

  it("does not false-positive on long content mentioning blocked phrases in context", () => {
    // A real policy page might mention "access denied claims" — should still pass
    // if the content is long enough.
    const longContent =
      "Medical Policy Update\n" +
      "Prior authorization is required for the following procedures.\n".repeat(30) +
      "Patients whose claims are access denied may appeal within 60 days.";
    expect(isMeaningful(longContent, minChars)).toBe(true);
  });
});
