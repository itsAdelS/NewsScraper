/**
 * Deterministic rendered-page discovery for payer article landing pages.
 *
 * This intentionally does not use an LLM. Link eligibility and date matching
 * are based only on hrefs and visible DOM text collected from Playwright.
 */

import type { BrowserContext } from "playwright";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { safeFetch } from "./base.js";
import { browserPool } from "./browser-pool.js";
import { UrlValidationError, validateUrl } from "../utils/validation.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_LOOKUP = new Map<string, number>(
  MONTHS.flatMap((month, index) => [
    [month.toLowerCase(), index],
    [month.slice(0, 3).toLowerCase(), index],
  ]),
);

const FULFILLED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "stylesheet",
  "xhr",
  "fetch",
]);

const DEFAULT_CONTENT_TYPES: Record<string, string> = {
  document: "text/html; charset=utf-8",
  script: "application/javascript; charset=utf-8",
  stylesheet: "text/css; charset=utf-8",
};

const EXCLUDED_LINK = /\b(?:archive|category|search|contact|log[ -]?in|sign[ -]?in|register|home|privacy|terms|cookie|accessibility|next|previous|pagination)\b/i;
const ARTICLE_LINK = /\b(?:article|update|news|bulletin|alert|announcement|network|reimbursement|policy|prior.?authorization|provider|medical)\b/i;
const SOCIAL_HOST = /(?:^|\.)(?:facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com)$/i;

export interface DiscoveryRequestBody {
  url: string;
  targetMonth?: string;
  targetYear?: string | number;
}

export interface DiscoveryTarget {
  monthIndex: number;
  month: string;
  year: number;
}

export interface DiscoveryArticle {
  title: string;
  Date: string;
  URL: string;
}

export interface DiscoveryDiagnostics {
  linksFound: number;
  linksMatched: number;
  pageRendered: boolean;
  errors: string[];
}

export interface DiscoveryResponse {
  PayerName: string;
  Landingpagetitle: string;
  Targetmonth: string;
  TargetYear: string;
  Articlecount: number;
  Articles: DiscoveryArticle[];
  diagnostics: DiscoveryDiagnostics;
}

export interface RenderedDiscoveryCandidate {
  href: string;
  title: string;
  context: string;
  sectionText: string;
}

export interface RenderedDiscoveryPage {
  finalUrl: string;
  title: string;
  payerName: string;
  candidates: RenderedDiscoveryCandidate[];
}

export class DiscoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryInputError";
  }
}

export class DiscoveryNavigationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 403 | 404 | 422 | 502 | 504,
  ) {
    super(message);
    this.name = "DiscoveryNavigationError";
  }
}

export function resolveDiscoveryTarget(
  targetMonth: unknown,
  targetYear: unknown,
  now = new Date(),
): DiscoveryTarget {
  if (targetMonth === undefined && targetYear === undefined) {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      monthIndex: previousMonth.getMonth(),
      month: MONTHS[previousMonth.getMonth()],
      year: previousMonth.getFullYear(),
    };
  }

  if (typeof targetMonth !== "string" || targetMonth.trim() === "") {
    throw new DiscoveryInputError(
      "Field 'targetMonth' must be a month name when a reporting period is supplied",
    );
  }
  if (targetYear === undefined || targetYear === null || `${targetYear}`.trim() === "") {
    throw new DiscoveryInputError(
      "Field 'targetYear' is required when targetMonth is supplied",
    );
  }

  const monthIndex = MONTH_LOOKUP.get(targetMonth.trim().toLowerCase());
  if (monthIndex === undefined) {
    throw new DiscoveryInputError(
      "Field 'targetMonth' must be a valid month name such as 'August'",
    );
  }

  if (typeof targetYear !== "string" && typeof targetYear !== "number") {
    throw new DiscoveryInputError("Field 'targetYear' must be a four-digit year");
  }
  const normalizedYear = String(targetYear).trim();
  if (!/^\d{4}$/.test(normalizedYear)) {
    throw new DiscoveryInputError("Field 'targetYear' must be a four-digit year");
  }
  const year = Number(normalizedYear);
  if (year < 2000 || year > 2100) {
    throw new DiscoveryInputError("Field 'targetYear' must be between 2000 and 2100");
  }

  return { monthIndex, month: MONTHS[monthIndex], year };
}

function whitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dateForTarget(text: string, target: DiscoveryTarget): string | null {
  const normalized = whitespace(text);
  const monthName = target.month;
  const monthPattern = `(?:${monthName}|${monthName.slice(0, 3)}\\.)`;
  const named = new RegExp(
    `\\b(?:${monthPattern}\\s+(?:\\d{1,2},?\\s+)?${target.year}|\\d{1,2}\\s+${monthPattern}\\s+${target.year})\\b`,
    "i",
  );
  const namedMatch = normalized.match(named);
  if (namedMatch) return namedMatch[0];

  const iso = new RegExp(`\\b${target.year}-${String(target.monthIndex + 1).padStart(2, "0")}-\\d{2}\\b`);
  const isoMatch = normalized.match(iso);
  if (isoMatch) return isoMatch[0];

  const monthNumber = target.monthIndex + 1;
  const numericMonth =
    monthNumber < 10 ? `0?${monthNumber}` : String(monthNumber);
  const numericYear = `(?:${target.year}|${String(target.year).slice(-2)})`;
  const numeric = new RegExp(
    `\\b${numericMonth}[/-]\\d{1,2}[/-]${numericYear}\\b|\\b\\d{1,2}[/-]${numericMonth}[/-]${numericYear}\\b`,
  );
  const numericMatch = normalized.match(numeric);
  return numericMatch?.[0] ?? null;
}

function normaliseArticleTitle(candidate: RenderedDiscoveryCandidate): string {
  const text = whitespace(candidate.title);
  if (text) return text.slice(0, 500);
  try {
    const pathname = new URL(candidate.href).pathname;
    const fallback = pathname.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") ?? "";
    return fallback.slice(0, 500) || candidate.href;
  } catch {
    return candidate.href;
  }
}

function isAllowedCandidate(candidate: RenderedDiscoveryCandidate): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate.href);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (SOCIAL_HOST.test(parsed.hostname)) return false;

  const signal = `${parsed.pathname} ${candidate.title} ${candidate.context}`.replace(/[-_/]+/g, " ");
  if (EXCLUDED_LINK.test(signal)) return false;
  return parsed.pathname.toLowerCase().endsWith(".pdf") || ARTICLE_LINK.test(signal);
}

/**
 * Filter rendered candidates into de-duplicated articles for one reporting
 * period. A month/year label on a containing section qualifies its undated
 * entries, exactly as a visible date on the entry itself would.
 */
export function collectDiscoveryArticles(
  candidates: RenderedDiscoveryCandidate[],
  target: DiscoveryTarget,
): DiscoveryArticle[] {
  const seen = new Set<string>();
  const articles: DiscoveryArticle[] = [];

  for (const candidate of candidates) {
    if (!isAllowedCandidate(candidate)) continue;
    let url: string;
    try {
      url = new URL(candidate.href).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const entryDate = dateForTarget(candidate.context, target);
    const sectionDate = dateForTarget(candidate.sectionText, target);
    const date = entryDate ?? sectionDate;
    if (!date) continue;

    seen.add(url);
    articles.push({ title: normaliseArticleTitle(candidate), Date: date, URL: url });
  }

  return articles;
}

async function addSsrfSafeRouting(
  context: BrowserContext,
  requestId: string,
): Promise<() => boolean> {
  let ssrfBlocked = false;
  await context.route("**", async (route) => {
    const requestUrl = route.request().url();
    const resourceType = route.request().resourceType();
    if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
      if (FULFILLED_RESOURCE_TYPES.has(resourceType)) await route.continue();
      else await route.abort("blockedbyclient");
      return;
    }
    if (!FULFILLED_RESOURCE_TYPES.has(resourceType)) {
      await route.abort("blockedbyclient");
      return;
    }

    try {
      const fetched = await safeFetch(requestUrl);
      await route.fulfill({
        status: fetched.statusCode || 200,
        contentType:
          fetched.contentType ?? DEFAULT_CONTENT_TYPES[resourceType] ?? "application/octet-stream",
        body: fetched.html,
      });
    } catch (error) {
      const blocked = error instanceof UrlValidationError && error.httpStatus === 403;
      ssrfBlocked ||= blocked;
      logger.warn(
        {
          requestId,
          requestUrl,
          resourceType,
          error: error instanceof Error ? error.message : String(error),
          ssrfBlocked: blocked,
        },
        "Discovery browser: failed to fetch rendered resource",
      );
      await route.abort(blocked ? "addressunreachable" : "failed");
    }
  });
  return () => ssrfBlocked;
}

/**
 * Render a landing page using the bounded browser pool and return only the
 * deterministic DOM signals needed for article discovery.
 */
export async function renderDiscoveryLandingPage(
  url: string,
  requestId: string,
): Promise<RenderedDiscoveryPage> {
  await validateUrl(url);
  const context = await browserPool.acquire();

  try {
    const wasSsrfBlocked = await addSsrfSafeRouting(context, requestId);
    const page = await context.newPage();
    let finalUrl = url;
    let statusCode = 0;
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") {
        finalUrl = response.url();
        statusCode = response.status();
      }
    });

    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.maxScraperTimeoutMs,
      });
      if (response) {
        finalUrl = response.url();
        statusCode = response.status();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed?\s*out/i.test(message)) {
        throw new DiscoveryNavigationError(`Discovery navigation timed out: ${message}`, 504);
      }
      if (wasSsrfBlocked()) {
        throw new DiscoveryNavigationError(`Discovery navigation blocked by SSRF protection: ${message}`, 403);
      }
      throw new DiscoveryNavigationError(`Discovery navigation failed: ${message}`, 502);
    }

    if (statusCode === 404) {
      throw new DiscoveryNavigationError("Landing page returned HTTP 404", 404);
    }
    if (statusCode < 200 || statusCode >= 400) {
      throw new DiscoveryNavigationError(`Landing page returned HTTP ${statusCode}`, 422);
    }

    await page.waitForTimeout(600);
    for (let i = 0; i < 5; i++) {
      const changed = await page.evaluate(() => {
        const win = globalThis as unknown as {
          scrollY: number;
          innerHeight: number;
          scrollBy: (x: number, y: number) => void;
        };
        const before = win.scrollY;
        win.scrollBy(0, Math.max(win.innerHeight, 700));
        return win.scrollY !== before;
      });
      if (!changed) break;
      await page.waitForTimeout(250);
    }

    const rendered = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: any }).document;
      const trim = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const nearestText = (anchor: any) => {
        const container = anchor.closest("article, li, tr, [class*='card' i], [class*='item' i], [class*='listing' i], [class*='result' i], section, div");
        return trim(container?.textContent).slice(0, 2000);
      };
      const sectionText = (anchor: any) => {
        let node: any = anchor.parentElement;
        const labels: string[] = [];
        for (let depth = 0; node && depth < 5; depth++) {
          const heading = node.querySelector("h1,h2,h3,h4,h5,h6");
          const text = trim(heading?.textContent);
          if (text) labels.push(text);
          let previous = node.previousElementSibling;
          for (let sibling = 0; previous && sibling < 3; sibling++) {
            const siblingText = trim(previous.textContent);
            if (siblingText) labels.push(siblingText.slice(0, 500));
            previous = previous.previousElementSibling;
          }
          if (node.tagName === "MAIN" || node.tagName === "BODY") break;
          node = node.parentElement;
        }
        return labels.join(" ").slice(0, 2500);
      };
      const candidates = Array.from(doc.querySelectorAll("a[href]") as any[])
        .map((anchor) => ({
          href: anchor.href,
          title: trim(anchor.getAttribute("aria-label") || anchor.textContent || anchor.getAttribute("title")),
          context: nearestText(anchor),
          sectionText: sectionText(anchor),
        }))
        .filter((candidate) => candidate.href);

      const payerName =
        trim(doc.querySelector("meta[property='og:site_name']")?.content) ||
        trim(doc.querySelector("meta[name='application-name']")?.content) ||
        "";
      return { title: trim(doc.title), payerName, candidates };
    });

    return { ...rendered, finalUrl };
  } finally {
    await browserPool.release(context);
  }
}

export function derivePayerName(page: RenderedDiscoveryPage): string {
  if (page.payerName) return page.payerName;
  try {
    return new URL(page.finalUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}