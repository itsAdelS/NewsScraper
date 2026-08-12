// Zod schemas (includes ScrapeResponse as a Zod schema)
export * from "./generated/api";

// TypeScript types — ScrapeResponse intentionally excluded here because
// generated/api.ts exports a Zod schema const with the same name, which
// causes a TS2308 duplicate-export error when both are re-exported via export *.
export type { ErrorResponse } from "./generated/types/errorResponse";
export type { HealthStatus } from "./generated/types/healthStatus";
export type { PayerNewsHealthStatus } from "./generated/types/payerNewsHealthStatus";
export type { ScrapeRequest } from "./generated/types/scrapeRequest";
export type { ScrapeRequestRoute } from "./generated/types/scrapeRequestRoute";
export type { ScrapeResponseScraperUsed } from "./generated/types/scrapeResponseScraperUsed";
