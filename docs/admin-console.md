# PayerNews Admin Console

Internal operations console at **`/admin`** on the API server. Completely
separate from the public scraper API — Power Automate's bearer-token flow is
untouched.

| Page | Purpose |
|---|---|
| `/admin/login` | Username + password sign-in |
| `/admin` | Dashboard: health, browser pool, utilization bar, scrape stats, recent scrapes (auto-refresh) |
| `/admin/requests` | Full request history with search, filters, pagination |
| `/admin/requests/{id}` | Per-request detail (timings, pool state, error, optional content preview) |
| `/admin/errors` | Failed scrapes with filtering |
| `/admin/controls` | Pause / Resume / Drain |

In development, open the **API Server** artifact preview and navigate to
`/admin`. In production: `https://payernews.replit.app/admin`.

## 1–5. Configuration (secrets / env vars)

| Key | Purpose |
|---|---|
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD_HASH` | **bcrypt hash** of the admin password (never plaintext) |
| `SESSION_SECRET` | Signs the session cookie (already configured) |

To set or rotate the password, generate a hash and store it:

```bash
cd artifacts/api-server
node scripts/hash-password.mjs 'your-new-password'
# copy the printed $2b$… hash into the ADMIN_PASSWORD_HASH secret
```

Optional tuning (env vars, with defaults):

| Key | Default | Meaning |
|---|---|---|
| `ADMIN_SESSION_HOURS` | `8` | Session lifetime (sliding, extended on activity) |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `5` | Failed logins per IP before lockout |
| `ADMIN_LOGIN_WINDOW_MINUTES` | `15` | Lockout window |
| `LOG_RETENTION_DAYS` | `30` | Request-history retention |
| `LOG_CONTENT_PREVIEW` | `false` | Opt in to storing a 500-char extracted-text preview (scraped pages may contain PII) |
| `PAUSE_RETRY_AFTER_SECONDS` | `300` | `retryAfterSeconds` hint while paused |

## 6–7. Request log storage & retention

Scrape request **metadata** is stored in the project's PostgreSQL database
(table `scrape_requests`, via the existing `@workspace/db` Drizzle layer) —
never full page content, tokens, or headers. Before persistence, URLs are
sanitized (userinfo credentials stripped; query parameters such as
`token`, `key`, `signature`, `access_token`, `X-Amz-*` redacted) and URLs
embedded in error messages get the same treatment. An optional 500-char
content preview is **off by default** (`LOG_CONTENT_PREVIEW=true` opts in).

If the scraper runs without a database (`DATABASE_URL` unset), history is
disabled gracefully — the scraper API keeps working. Note: publishing to
production requires creating the table in the production database first
(schema push — tracked as a follow-up task).

Rows older than `LOG_RETENTION_DAYS` (default 30) are pruned at boot and then
hourly.

## 8. Pause / Resume / Drain

- **Pause** — new `POST /api/scrape` calls get HTTP 503 with
  `{"success":false,"status":"paused","error":"Scraping is temporarily paused by administrator.","retryAfterSeconds":300}`
  (plus a `Retry-After` header). Active and queued jobs finish normally.
- **Drain** — identical gating (`status: "draining"`); intended for
  pre-restart wind-down. Nothing queued is ever deleted.
- **Resume** — returns to normal operation.

State is in-memory and resets to *normal* on restart (safe default). All
controls are POST-only, session-authenticated, and CSRF-protected. There is
deliberately no destructive queue flush.

## 9. Was /api/scrape changed?

The request/response contract is **unchanged**. Two additions only:

1. A gate at the top of the handler returns the 503 "paused" body when an
   administrator has paused/drained — otherwise the code path is identical.
2. Fire-and-forget history logging around the existing responses (a logging
   failure can never affect the API response).

`/api/health` and `/api/healthz` are untouched.

## 10. Brute-force protection

Failed logins are counted per IP; after 5 failures within 15 minutes, further
attempts (even with the correct password) get HTTP 429 until the window
passes. Login errors are always the generic "Invalid username or password."
Password checks use bcrypt and run even on username mismatch to keep response
timing flat.

## 11. Sessions

256-bit random session IDs held server-side (in memory), delivered in a
signed (`SESSION_SECRET`), `HttpOnly`, `SameSite=Lax`, `Secure`-over-HTTPS
cookie. Expiry is sliding: 8 hours (configurable) from last activity. Logout
destroys the server-side session. Restarting the server invalidates all
sessions.

## 12. Request IDs

`PN-YYYYMMDD-XXXXXX` — date plus 6 random hex characters (e.g.
`PN-20260816-FADCEC`), generated per scrape request and returned in the admin
console only (the public API response is unchanged).

## 13. Queue utilization

`utilisation = active contexts / PLAYWRIGHT_MAX_CONTEXTS × 100`, identical to
`/api/health`. Dashboard bands: 0–59% Healthy, 60–79% Elevated, 80–89%
Warning, 90%+ Critical. The alert-state machine (healthy → warning ≥ warn
threshold → critical ≥ 90% → recovered < 60% → healthy after 60s) samples
every 5s and logs transitions once per change.

## Machine-readable endpoints

`GET /api/admin/status` and `GET /api/admin/alerts` accept **either** an admin
session **or** the API bearer key, so a Power Automate flow can poll them for
alerting:

```bash
curl -H "Authorization: Bearer $PAYERNEWS_API_KEY" https://payernews.replit.app/api/admin/status
curl -H "Authorization: Bearer $PAYERNEWS_API_KEY" https://payernews.replit.app/api/admin/alerts
```

## 14. Safe testing

Everything can be exercised without touching production traffic:

1. Open `/admin/login` in the dev preview → sign in.
2. Trigger a few scrapes from the Scraper Testing UI → watch them appear on
   the dashboard and in Requests.
3. Controls → Pause → run a scrape from the testing UI → observe the 503
   "paused" response → Resume.
4. Enter a wrong password 5 times → observe lockout → wait 15 minutes.
5. Nothing here mutates scraper behavior except the explicit pause gate.
