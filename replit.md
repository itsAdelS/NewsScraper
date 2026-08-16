# PayerNews Scraper

A production-oriented web scraping API that replaces Microsoft Power Automate Desktop browser scraping. Power Automate POSTs a payer webpage URL; the API scrapes it, extracts clean readable text, and returns predictable JSON for downstream AI classification by a Copilot agent.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port varies; proxied at `/api`)
- `pnpm --filter @workspace/api-server run test` — run all 68 automated tests
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Scraping: Node.js built-in `fetch` (with manual redirect following) + cheerio (HTML parsing) + Playwright (headless Chromium fallback)
- API codegen: Orval (from OpenAPI spec in `lib/api-spec/openapi.yaml`)
- Build: esbuild (CJS bundle)
- Tests: vitest

## Where things live

- `artifacts/api-server/src/routes/scrape.ts` — POST /api/scrape route handler
- `artifacts/api-server/src/routes/health.ts` — GET /api/health endpoint
- `artifacts/api-server/src/scrapers/` — scraper engine classes (base, static, browser, generic, payer-specific)
- `artifacts/api-server/src/scrapers/registry.ts` — route registry and domain auto-detection map
- `artifacts/api-server/src/utils/cleanup.ts` — HTML → clean text extraction (table conversion, boilerplate removal)
- `artifacts/api-server/src/utils/validation.ts` — URL validation and SSRF protection
- `artifacts/api-server/src/middleware/auth.ts` — Bearer token authentication
- `artifacts/api-server/src/config.ts` — configurable limits (timeout, redirects, body size, max chars)
- `artifacts/api-server/src/__tests__/` — 68 automated tests covering all 15 specified test cases
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contracts)

## API Reference

### POST /api/scrape
```
Authorization: Bearer <PAYERNEWS_API_KEY>
Content-Type: application/json

{ "url": "https://example.com/policy-page", "route": "generic" }
```

The `route` field is optional. If omitted, the domain is auto-detected (e.g. anthem.com → anthem). Supported routes: `generic`, `anthem`, `aetna`, `uhc`, `cigna`.

Successful response includes: `success`, `url`, `finalUrl`, `route`, `scraperUsed`, `title`, `content`, `contentLength`, `statusCode`, `durationMs`, `truncated`.

### GET /api/health
No auth required. Returns `{ "status": "healthy", "service": "PayerNews Scraper" }`.

## Admin Console

Internal ops console at `/admin` (production) and `/api/admin-console` (reachable through the dev preview whose base path is `/api`). Full docs: `docs/admin-console.md`.

- Auth: `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` (bcrypt — generate via `node artifacts/api-server/scripts/hash-password.mjs '<pw>'`), sessions signed with `SESSION_SECRET`. Completely separate from the API bearer token.
- Pages: dashboard, requests (search/filter/pagination), request detail, errors, controls (pause/resume/drain).
- JSON API under `/api/admin/*`; `status` and `alerts` also accept the API bearer key (for Power Automate polling).
- Request history stored in Postgres table `scrape_requests` (30-day retention, hourly pruning). Request IDs: `PN-YYYYMMDD-XXXXXX`.
- Pause/drain gate `POST /api/scrape` with 503 `{success:false,status:"paused"|"draining",...}`; state is in-memory and resets to normal on restart.
- Code: `artifacts/api-server/src/admin/` (sessions, middleware, UI router), `src/routes/admin.ts` (JSON API), `src/lib/{ops-state,alerts,request-log}.ts`.

## Environment Variables / Secrets

- `PAYERNEWS_API_KEY` — **Required.** The Bearer token Power Automate sends in the `Authorization` header. Set as a Replit Secret (never hardcode).
- `SCRAPER_TIMEOUT_MS` — Default: 30000 (30s)
- `MAX_REDIRECTS` — Default: 5
- `MAX_BODY_BYTES` — Default: 10485760 (10 MB)
- `MAX_EXTRACTED_CHARS` — Default: 500000
- `MIN_MEANINGFUL_CHARS` — Default: 200

## Architecture decisions

- **Node.js / TypeScript instead of Python/FastAPI**: The monorepo is TypeScript/Express; Node.js has exact equivalents (cheerio ≈ BeautifulSoup, playwright ≈ playwright, built-in fetch ≈ httpx). Avoids a second language runtime.
- **Manual redirect following**: Built-in `fetch` with `redirect: 'manual'` so every redirect hop is SSRF-validated before being followed.
- **Static → Playwright fallback**: Generic route tries the fast static scraper first; only launches headless Chromium when content is insufficient (< MIN_MEANINGFUL_CHARS or failure-phrase match on short pages).
- **Payer scraper inheritance**: `AnthemScraper`, `AetnaScraper`, `UHCScraper`, `CignaScraper` all extend `GenericScraper`. Override `postProcessContent()` to add payer-specific rules without code duplication.
- **Singleton logger for scrape events**: Scrape routes use the singleton `logger` (not `req.log`) so logging works both in production (pino-http attaches to req) and in tests (bare express app).
- **Playwright externalized at build time**: `build.mjs` already externalizes `playwright`; Chromium binaries are in `.cache/ms-playwright/`.

## Product

PayerNews Scraper replaces Microsoft Power Automate Desktop browser scraping. Power Automate sends a payer webpage URL; the scraper visits it, strips boilerplate, converts tables to readable text, and returns clean JSON. A downstream Copilot agent classifies the content (Structured Policy Update / Article / Needs Review). The scraper never performs AI classification.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Playwright Chromium must be installed separately: `npx playwright install chromium`. The binary is in `.cache/ms-playwright/`.
- `playwright` is externalized in `artifacts/api-server/build.mjs` (line 99) — it will NOT be bundled; it loads from node_modules at runtime.
- Never use `pnpm run dev` at the workspace root — use workflows or `pnpm --filter @workspace/api-server run dev`.
- The `PAYERNEWS_API_KEY` must be set as a Replit Secret before any scrape request will authenticate.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
