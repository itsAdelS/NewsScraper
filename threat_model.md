# Threat Model

## Project Overview

PayerNews Scraper is a production-oriented web scraping API built with Node.js 24, TypeScript, and Express 5. It accepts `POST /api/scrape` requests from Microsoft Power Automate (M2M), visits the provided payer webpage URL, strips boilerplate HTML, and returns clean JSON text for downstream AI classification. Deployed publicly on Replit (autoscale). Primary consumer is a single Power Automate automation running in a corporate environment.

Tech stack: Express 5, PostgreSQL + Drizzle ORM, Zod validation, Playwright (headless Chromium fallback), Node.js built-in http/https with custom DNS-pinned fetch for SSRF prevention.

## Assets

- **API bearer token (`PAYERNEWS_API_KEY`)** — The only credential that controls access to the scrape endpoint. Compromise allows arbitrary web scraping through the server and unlimited Playwright execution.
- **Admin credentials (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`)** — Controls access to the admin console (pause/drain/resume scraping, view request history). Compromise allows operational disruption.
- **Scrape request history (PostgreSQL)** — Contains URLs scraped, domain names, error messages, and optional content previews. URLs may include path segments that encode patient or policy information.
- **Playwright browser process** — A shared Chromium instance. Abuse could exhaust memory/CPU or be used as a stepping stone for SSRF via the browser's network stack.
- **Application secrets** — `PAYERNEWS_API_KEY`, `SESSION_SECRET`, database connection string, `ADMIN_PASSWORD_HASH`. Stored as Replit Secrets; never hardcoded.

## Trust Boundaries

- **Internet → `/api/scrape`** — Power Automate POSTs here. Auth: Bearer token. Any holder of the token can trigger scraping.
- **Internet → `/admin` / `/api/admin-console`** — Admin UI. Auth: username + bcrypt password hash. Session cookie (HttpOnly, SameSite=Lax, Secure, signed with `SESSION_SECRET`). CSRF-protected state-changing actions.
- **Internet → `/api/health`** — No auth; returns minimal health JSON. No sensitive data.
- **API server → Target payer URLs** — The server fetches arbitrary URLs from payer websites. SSRF protection prevents requests to private/reserved ranges.
- **API server → PostgreSQL** — Internal; uses Drizzle ORM with parameterized queries.
- **API server → Playwright Chromium** — Internal IPC; Playwright's network requests intercepted and routed through SSRF-safe client.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/routes/scrape.ts` (POST /api/scrape), `artifacts/api-server/src/routes/admin.ts` (GET/POST /api/admin/*), `artifacts/api-server/src/admin/router.ts` (admin UI)
- **Highest-risk code areas:** `artifacts/api-server/src/utils/safe-fetch.ts` (SSRF protection), `artifacts/api-server/src/utils/validation.ts` (URL validation), `artifacts/api-server/src/middleware/auth.ts` (bearer auth), `artifacts/api-server/src/admin/sessions.ts` (session/credential management), `artifacts/api-server/src/scrapers/browser-scraper.ts` (Playwright SSRF intercept)
- **Public surface:** `GET /api/health` only
- **Authenticated surface:** `POST /api/scrape` (bearer token), `GET|POST /api/admin/*` (session cookie or bearer for status/alerts)
- **Dev-only areas:** `artifacts/mockup-sandbox/` (Canvas mockup, not reachable in production under `/api`)

## Threat Categories

### Spoofing

The scrape endpoint uses a bearer token checked with a custom timing-safe comparison (`auth.ts`). The admin console uses bcrypt password verification with constant-time username comparison and a brute-force rate limiter (5 attempts per 15-minute window per IP, stored in-memory).

**Guarantees required:** `PAYERNEWS_API_KEY` must be set as a Replit Secret and rotated if disclosed. Admin login rate limits reset on server restart — a crash-restart cycle could give an attacker a fresh window; the bcrypt cost is still the primary defense.

### Tampering

All request bodies are validated with Zod. Route selection from user-supplied `route` field is restricted to a defined allow-list in the registry. No price, permission, or billing fields are present.

**Guarantees required:** The `route` field must continue to be resolved through the registry's allow-list, never interpolated directly into filesystem paths or shell commands.

### Information Disclosure

- Scrape request history: URLs are stored in PostgreSQL. The `LOG_CONTENT_PREVIEW` flag (off by default) gates storing scraped content. URLs/errors are credential-redacted before persistence.
- Error responses return user-facing messages without stack traces or internal details (global error handler enforces this).
- Logs use pino with structured fields; the bearer token is never logged (`auth.ts` explicitly avoids logging the key value).
- CORS is `*` (all origins) — acceptable for M2M bearer-token auth since cookies are not used for API auth, but worth monitoring if auth model changes.

**Guarantees required:** `LOG_CONTENT_PREVIEW` must remain `false` in production unless explicitly opted in, as scraped payer content may contain PHI. Admin console must remain scoped to authenticated sessions.

### Denial of Service

- The Playwright browser pool caps concurrent contexts (`PLAYWRIGHT_MAX_CONTEXTS`, default 4) and queue depth (`PLAYWRIGHT_MAX_QUEUE`, default 20). Pool exhaustion returns HTTP 503.
- No per-IP or per-token rate limiting on `POST /api/scrape`. A single bearer-token holder can send unlimited requests.
- Scraper timeout enforced at `SCRAPER_TIMEOUT_MS` (default 30s). Body size limited at `MAX_BODY_BYTES` (default 10 MB).

**Guarantees required:** The single authorized caller (Power Automate) is trusted; however, if the token is leaked, there is no secondary rate limit preventing pool exhaustion. Consider adding rate limiting if the token is ever shared more broadly.

### Elevation of Privilege

- SSRF is mitigated by DNS-pinning in `safe-fetch.ts`: the custom `lookup` callback validates IPs before the TCP socket connects, preventing DNS rebinding. This applies to both static HTTP scraping and Playwright (browser network requests intercepted and routed through `safeFetch`).
- Playwright is prevented from making direct network requests; all HTTP traffic is proxied through the SSRF-safe client.
- Admin controls (pause/resume/drain) require both a session cookie and a per-session CSRF token sent as a request header.
- No SQL injection surface: all database access uses Drizzle ORM with parameterized queries.

**Guarantees required:** Any new network-making code path (new scraper, redirect follower, webhook caller) must use `safeFetch` or equivalent DNS-pinned HTTP client, not Node.js built-in `fetch` or `undici` directly.
