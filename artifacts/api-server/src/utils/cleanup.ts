/**
 * HTML → clean readable text extraction.
 *
 * Design goals:
 *  - Preserve structure (headings, paragraphs, lists, tables) using line breaks.
 *  - Convert HTML tables to readable pipe-delimited plain text.
 *  - Remove boilerplate/non-content elements without accidentally discarding
 *    payer policy information.
 *  - Normalize whitespace without collapsing meaningful line breaks.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

/** Phrases that indicate a page failed to load meaningful content. */
const FAILURE_PHRASES = [
  "access denied",
  "403 forbidden",
  "page not found",
  "javascript is required",
  "javascript must be enabled",
  "please enable javascript",
  "please enable cookies",
  "this site requires javascript",
  "verify you are human",
  "captcha",
  "ddos protection",
  "bot detection",
  "checking your browser",
];

/**
 * CSS selectors for elements that are almost never payer policy content
 * and should be removed before text extraction.
 *
 * IMPORTANT: Err on the side of keeping content; only remove elements
 * that are unambiguously boilerplate.
 */
const BOILERPLATE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  // Navigation elements with aria roles
  '[role="navigation"]',
  '[role="banner"]',
  '[aria-label="breadcrumb"]',
  // Common cookie/accessibility widgets
  "#onetrust-consent-sdk",
  ".cookie-banner",
  ".cookie-notice",
  ".cookie-consent",
  "#cookie-law-info-bar",
  ".cc-window",
  "#gdpr-cookie-notice",
  // Accessibility overlays
  "#accessibility-widget",
  ".ada-chat-button",
  // Skip-nav links
  ".skip-nav",
  ".skip-to-content",
  // Print / share buttons that add clutter
  ".print-only",
  "[aria-hidden='true']",
].join(", ");

/**
 * Converts a single HTML table element to a readable plain-text block.
 * Each row becomes one line; cells are separated with " | ".
 */
function tableToText($: cheerio.CheerioAPI, table: AnyNode): string {
  const rows: string[] = [];

  $(table)
    .find("tr")
    .each((_: number, tr: AnyNode) => {
      const cells: string[] = [];
      $(tr)
        .find("th, td")
        .each((_2: number, cell: AnyNode) => {
          const cellText = $(cell).text().replace(/\s+/g, " ").trim();
          cells.push(cellText);
        });
      if (cells.some((c) => c.length > 0)) {
        rows.push(cells.join(" | "));
      }
    });

  return rows.join("\n");
}

/**
 * Extracts page title from the HTML document.
 */
export function extractTitle(html: string): string {
  const $ = cheerio.load(html);
  return $("title").first().text().trim();
}

/**
 * Extracts clean readable text from HTML.
 *
 * Returns the extracted text, which may be an empty string if the page
 * contains no meaningful content.
 */
export function extractText(html: string): string {
  const $ = cheerio.load(html);

  // --- Step 1: Remove boilerplate elements ---
  $(BOILERPLATE_SELECTORS).remove();

  // Specifically handle <header> / <footer> — remove only if they look
  // like site navigation (no <p> or article descendants with policy text).
  $("header").each((_: number, el: AnyNode) => {
    const hasContentBlocks = $(el).find("p, article, section").length > 0;
    if (!hasContentBlocks) {
      $(el).remove();
    }
  });
  $("footer").each((_: number, el: AnyNode) => {
    const hasContentBlocks =
      $(el).find("article, section, p").length > 2;
    if (!hasContentBlocks) {
      $(el).remove();
    }
  });

  // Remove <nav> elements (typically site navigation).
  $("nav").remove();

  // --- Step 2: Convert tables to plain text before extraction ---
  $("table").each((_: number, table: AnyNode) => {
    const text = tableToText($, table);
    $(table).replaceWith(`\n\n${text}\n\n`);
  });

  // --- Step 3: Add structural line breaks for block-level elements ---
  // Headings get a blank line before and after.
  $("h1, h2, h3, h4, h5, h6").each((_: number, el: AnyNode) => {
    const text = $(el).text().trim();
    $(el).replaceWith(`\n\n${text}\n`);
  });

  // Paragraphs and block containers get a newline after.
  $("p, div, section, article, main, blockquote").each(
    (_: number, el: AnyNode) => {
      $(el).append("\n");
    },
  );

  // List items get a newline.
  $("li").each((_: number, el: AnyNode) => {
    $(el).prepend("• ");
    $(el).append("\n");
  });

  // Line breaks become newlines.
  $("br").replaceWith("\n");

  // --- Step 4: Extract text from <body> or whole document ---
  let text: string;
  if ($("body").length) {
    text = $("body").text();
  } else {
    text = $.root().text();
  }

  // --- Step 5: Normalize whitespace ---
  // Collapse runs of spaces/tabs to a single space on each line.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  // Collapse runs of 3+ newlines to 2 newlines.
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Returns true if the extracted text is considered "meaningful" —
 * i.e., it has enough content and does not appear to be an error/block page.
 *
 * Only checks failure phrases for short pages (< 500 chars).  Longer pages
 * may legitimately mention error terms in context (e.g. "access denied claims
 * may be appealed") and should not be falsely rejected.
 */
export function isMeaningful(text: string, minChars: number): boolean {
  if (text.length < minChars) return false;

  // Only apply failure-phrase detection to very short pages.
  // Real blocked/error pages are typically under 500 characters.
  if (text.length < 500) {
    const lower = text.toLowerCase();
    for (const phrase of FAILURE_PHRASES) {
      if (lower.includes(phrase)) return false;
    }
  }

  return true;
}
