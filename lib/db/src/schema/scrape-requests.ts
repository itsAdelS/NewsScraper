import {
  pgTable,
  text,
  serial,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persistent scrape request history for the admin console.
 * Metadata only — never full page content or credentials.
 */
export const scrapeRequestsTable = pgTable(
  "scrape_requests",
  {
    id: serial("id").primaryKey(),
    /** Human-readable request ID, e.g. PN-20260815-A38F91 */
    requestId: text("request_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    url: text("url").notNull(),
    finalUrl: text("final_url").notNull().default(""),
    domain: text("domain").notNull().default(""),
    route: text("route").notNull().default(""),
    /** "static" | "playwright" | "" */
    scraperUsed: text("scraper_used").notNull().default(""),
    httpStatus: integer("http_status").notNull().default(0),
    success: boolean("success").notNull().default(false),
    contentLength: integer("content_length").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    /** True when the playwright engine was used (static was insufficient). */
    playwrightFallback: boolean("playwright_fallback").notNull().default(false),
    errorMessage: text("error_message"),
    /** Pool state captured when the request began. */
    queueDepthAtStart: integer("queue_depth_at_start").notNull().default(0),
    activeContextsAtStart: integer("active_contexts_at_start")
      .notNull()
      .default(0),
    /** Optional short diagnostic preview (first 500 chars of extracted text). */
    contentPreview: text("content_preview"),
  },
  (t) => [
    index("scrape_requests_created_at_idx").on(t.createdAt),
    index("scrape_requests_domain_idx").on(t.domain),
    index("scrape_requests_success_idx").on(t.success),
  ],
);

export const insertScrapeRequestSchema = createInsertSchema(
  scrapeRequestsTable,
).omit({ id: true, createdAt: true });
export type InsertScrapeRequest = z.infer<typeof insertScrapeRequestSchema>;
export type ScrapeRequestRecord = typeof scrapeRequestsTable.$inferSelect;
