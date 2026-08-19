import { describe, expect, it } from "vitest";
import type { ScrapeRequestRoute } from "@workspace/api-zod";
import type { ScraperRoute } from "../scrapers/registry.js";

type MissingContractRoute = Exclude<ScraperRoute, ScrapeRequestRoute>;
type ExtraContractRoute = Exclude<ScrapeRequestRoute, ScraperRoute>;

// These assignments are compile-time contract checks. If the OpenAPI-generated
// route union and server registry drift, API server typechecking fails.
const allRegistryRoutesAreDocumented: MissingContractRoute extends never
  ? true
  : never = true;
const allDocumentedRoutesAreImplemented: ExtraContractRoute extends never
  ? true
  : never = true;

describe("scrape route API contract", () => {
  it("keeps the OpenAPI route enum aligned with the server registry", () => {
    expect(allRegistryRoutesAreDocumented).toBe(true);
    expect(allDocumentedRoutesAreImplemented).toBe(true);
  });
});