# PayerNews Scraper — Azure APIM Onboarding Package

Everything needed to import the API into Azure API Management (APIM) and
configure the backend.

---

## 1. OpenAPI Specification

| | |
|---|---|
| **Format** | OpenAPI 3.0.3 (YAML) |
| **Hosted URL** | `https://payernews.replit.app/api/openapi.yaml` |
| **Local file** | `docs/openapi.yaml` (this repository) |

The spec is served live by the API itself — no separate hosting needed.
Import it directly into APIM using the URL above.

> **APIM import steps:**
> APIM portal → APIs → Add API → OpenAPI →
> paste `https://payernews.replit.app/api/openapi.yaml` → Create.

---

## 2. Backend URL

```
https://payernews.replit.app/api
```

All endpoints sit under this base. Set this as the **Backend service URL**
in APIM's backend configuration.

| Endpoint | Full URL |
|---|---|
| Scrape | `POST https://payernews.replit.app/api/scrape` |
| Health (extended) | `GET  https://payernews.replit.app/api/health` |
| Liveness probe | `GET  https://payernews.replit.app/api/healthz` |
| OpenAPI spec | `GET  https://payernews.replit.app/api/openapi.yaml` |

---

## 3. Authentication

### Mechanism

**API Key passed as a Bearer token.** There is no OAuth 2.0 or Entra ID
flow in the current implementation. A single shared secret is compared
on every scrape request using a timing-safe comparison.

### Auth flow

```
Power Automate / Caller
        │
        │  POST /api/scrape
        │  Authorization: Bearer <PAYERNEWS_API_KEY>
        ▼
┌─────────────────────────┐
│  APIM (gateway layer)   │  ← Recommended: validate/strip key here,
│                         │    forward with a new credential to backend
└───────────┬─────────────┘
            │  (forwarded request)
            ▼
┌─────────────────────────┐
│  PayerNews API (Express)│
│  auth middleware        │  reads process.env.PAYERNEWS_API_KEY
│  timing-safe compare    │  timingSafeEqual(stored, provided)
└───────────┬─────────────┘
            │  pass / fail
            ▼
       Scrape handler  (or 401 Unauthorized)
```

### Key storage

| Location | Value |
|---|---|
| Replit Secret name | `PAYERNEWS_API_KEY` |
| Never in source code | ✅ confirmed |
| Logged | ❌ never |

### APIM options (choose one)

| Option | Notes |
|---|---|
| **Pass-through** | APIM forwards `Authorization: Bearer <key>` unchanged. Caller holds the key. Simplest — good for internal Power Automate flows. |
| **Key Vault + named value** | Store the key in Azure Key Vault, reference it as an APIM named value, inject it via `set-header` policy. Callers authenticate to APIM separately (e.g., subscription key or Entra ID); APIM adds the backend key automatically. Recommended for production. |
| **Entra ID (OAuth 2.0)** | Not yet implemented in the API. APIM can front it with Entra ID validation (`validate-jwt` policy) while forwarding the backend key from Key Vault — providing OAuth to callers without changing the API. |

### Endpoints that require auth

| Endpoint | Auth required |
|---|---|
| `POST /api/scrape` | ✅ Yes — `Authorization: Bearer <key>` |
| `GET /api/health` | ❌ No |
| `GET /api/healthz` | ❌ No |
| `GET /api/openapi.yaml` | ❌ No |

---

## 4. Required Request Headers

For `POST /api/scrape`:

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <PAYERNEWS_API_KEY>` | ✅ |
| `Content-Type` | `application/json` | ✅ |

---

## 5. Sample Request & Response

### Request

```http
POST https://payernews.replit.app/api/scrape
Authorization: Bearer <PAYERNEWS_API_KEY>
Content-Type: application/json

{
  "url": "https://providernews.anthem.com/california/articles/some-article-slug",
  "route": "anthem"
}
```

The `route` field is optional — when omitted the API auto-detects the payer
from the URL hostname.

### Successful response — `200 OK`

```json
{
  "success": true,
  "url": "https://providernews.anthem.com/california/articles/some-article-slug",
  "finalUrl": "https://providernews.anthem.com/california/articles/some-article-slug",
  "route": "anthem",
  "scraperUsed": "playwright",
  "title": "Take Action: Use No-Cost Electronic Claims and Payments",
  "content": "Take Action: Use No-Cost Electronic Claims and Payments\n\nEffective January 1 ...",
  "contentLength": 3990,
  "statusCode": 200,
  "durationMs": 7016,
  "truncated": false
}
```

**Your Copilot agent reads:** `body['content']`

### Failure response — `422 Unprocessable Entity`

```json
{
  "success": false,
  "url": "https://some-payer-site.com/article",
  "finalUrl": "https://some-payer-site.com/article",
  "route": "generic",
  "scraperUsed": "playwright",
  "title": "",
  "content": "",
  "contentLength": 0,
  "statusCode": 403,
  "durationMs": 5211,
  "truncated": false,
  "error": "Target server returned HTTP 403"
}
```

### Browser pool full — `503 Service Unavailable`

```json
{
  "success": false,
  "error": "Too many concurrent scrape requests — try again shortly"
}
```

Retry after 2–5 seconds with exponential backoff.

### SSRF blocked — `403 Forbidden`

```json
{
  "success": false,
  "error": "Requests to private or reserved IP addresses are not permitted"
}
```

---

## 6. Source Framework

| | |
|---|---|
| **Runtime** | Node.js (v20+) |
| **Framework** | Express 5 (TypeScript) |
| **Scraping engines** | `cheerio` (static) · Playwright / Chromium (JS-heavy pages) |
| **Deployment** | Replit Deploy (containerised Node.js) |
| **Build tool** | esbuild (single-bundle `dist/index.mjs`) |
| **Spec generation** | Hand-authored OpenAPI 3.0.3 YAML, served live at `/api/openapi.yaml` |

No FastAPI, Flask, or auto-generation library is used. The spec was written
by hand and is served as a static file from the running API — it is always
in sync with the deployed version because it ships with the same build.

---

## 7. APIM Configuration Checklist

```
[ ] Import spec from https://payernews.replit.app/api/openapi.yaml
[ ] Set Backend URL to https://payernews.replit.app/api
[ ] Decide auth strategy (pass-through vs. Key Vault named value vs. Entra ID front)
[ ] Store PAYERNEWS_API_KEY in Key Vault if using named-value approach
[ ] Configure set-header policy to inject Authorization header from named value
[ ] Add retry policy for 503 responses (pool full) — recommended: 3 retries, 2 s base
[ ] Configure health check probe: GET /api/healthz → expect {"status":"ok"}
[ ] Set operation-level timeout ≥ 35 s (scrapes can take up to 30 s + buffer)
[ ] (Optional) Add rate limiting per subscription key
[ ] (Optional) Add validate-jwt policy for Entra ID if standardising on OAuth
```

---

## 8. Health Check for APIM Backend

Use this as the APIM backend health probe URL:

```
GET https://payernews.replit.app/api/healthz
```

Expected response (always `200 OK`, no auth):

```json
{"status": "ok"}
```

For deeper diagnostics (pool load, degraded status):

```
GET https://payernews.replit.app/api/health
```

```json
{
  "status": "healthy",
  "service": "PayerNews Scraper",
  "browserPool": {
    "active": 0,
    "queued": 0,
    "browserRunning": false,
    "maxContexts": 4,
    "maxQueue": 20,
    "utilisation": 0,
    "warnThresholdPct": 80
  }
}
```

`status` changes to `"degraded"` (but remains `200 OK`) when pool
utilisation hits 80 % — useful for alerting before hitting 503s.
