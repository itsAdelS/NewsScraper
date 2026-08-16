/**
 * Admin console UI — server-rendered HTML pages mounted at /admin.
 *
 * Pages are static shells; live data is fetched client-side from
 * /api/admin/* (same-origin, session cookie).  All links and fetches
 * compute the path prefix client-side so the console works both behind
 * the dev proxy (path-prefixed) and in production (root).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  createSession,
  getSession,
  destroySession,
  verifyCredentials,
  isAdminConfigured,
  isLockedOut,
  recordLoginFailure,
  clearLoginFailures,
  SESSION_COOKIE,
} from "./sessions.js";
import { requireAdminPage, type AdminRequest } from "./middleware.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/** HTML-escape untrusted text before interpolating into server-rendered HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Shared layout ─────────────────────────────────────────────────────────────

const STYLE = `
:root{--bg:#0f1419;--panel:#1a2129;--border:#2b3540;--text:#e6ebf0;--muted:#8b98a5;
--green:#3fb950;--yellow:#d29922;--orange:#f0883e;--red:#f85149;--blue:#58a6ff;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:24px;padding:12px 24px;background:var(--panel);border-bottom:1px solid var(--border);flex-wrap:wrap}
header .brand{font-weight:600;font-size:15px}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{padding:6px 12px;border-radius:6px;color:var(--muted)}
nav a.active,nav a:hover{background:var(--bg);color:var(--text);text-decoration:none}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin-bottom:16px}h2{font-size:15px;margin-bottom:10px;color:var(--muted);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px}
.card .big{font-size:26px;font-weight:600;margin:4px 0}
.kv{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}
.kv span:first-child{color:var(--muted)}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.badge.green{background:rgba(63,185,80,.15);color:var(--green)}
.badge.yellow{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge.orange{background:rgba(240,136,62,.15);color:var(--orange)}
.badge.red{background:rgba(248,81,73,.15);color:var(--red)}
.badge.gray{background:rgba(139,152,165,.15);color:var(--muted)}
.bar{height:10px;background:var(--bg);border:1px solid var(--border);border-radius:5px;overflow:hidden;margin:8px 0 4px}
.bar>div{height:100%;width:0;transition:width .4s;border-radius:5px}
.banner{display:none;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600}
.banner.warn{display:block;background:rgba(210,153,34,.12);border:1px solid var(--yellow);color:var(--yellow)}
.banner.crit{display:block;background:rgba(248,81,73,.12);border:1px solid var(--red);color:var(--red)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap}
th{color:var(--muted);font-weight:600;background:rgba(0,0,0,.15)}
tbody tr:hover{background:rgba(88,166,255,.05);cursor:pointer}
tbody tr.norow:hover{background:none;cursor:default}
td.url{max-width:260px;overflow:hidden;text-overflow:ellipsis}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
input,select,button{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:13px}
input:focus,select:focus{outline:none;border-color:var(--blue)}
button{cursor:pointer;background:var(--panel)}button:hover{border-color:var(--blue)}
button.primary{background:var(--blue);color:#0b1520;border-color:var(--blue);font-weight:600}
button.danger{background:rgba(248,81,73,.15);color:var(--red);border-color:var(--red)}
button.warning{background:rgba(210,153,34,.15);color:var(--yellow);border-color:var(--yellow)}
button:disabled{opacity:.5;cursor:not-allowed}
.pager{display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--muted);font-size:13px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,monospace}
.detail dt{color:var(--muted);font-size:12px;margin-top:10px}.detail dd{margin:2px 0 0}
pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:12px}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:32px;width:340px}
.login-box h1{font-size:18px;margin-bottom:4px}.login-box p{color:var(--muted);font-size:13px;margin-bottom:20px}
.login-box label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
.login-box input{width:100%}
.login-box button{width:100%;margin-top:20px;padding:9px}
.error-msg{background:rgba(248,81,73,.12);border:1px solid var(--red);color:var(--red);padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:8px}
.footnote{margin-top:16px;color:var(--muted);font-size:12px}
`;

const BASE_SCRIPT = `
// The console is mounted at /admin (production root) AND /api/admin-console
// (reachable through the dev preview, whose base path is /api). Detect which
// mount — plus any proxy prefix — from the current URL.
const __m = location.pathname.match(/^(.*?)(\\/api\\/admin-console|\\/admin)(\\/|$)/);
const PREFIX = __m ? __m[1] : '';
const CONSOLE = PREFIX + (__m ? __m[2] : '/admin');
const API = PREFIX + '/api/admin';
document.querySelectorAll('[data-nav]').forEach(a => { a.href = CONSOLE + a.dataset.nav; });
async function api(path, opts) {
  const r = await fetch(API + path, opts);
  if (r.status === 401) { location.href = CONSOLE + '/login'; throw new Error('unauthenticated'); }
  return r.json();
}
function esc(s){ return String(s ?? ''); }
function fmtDur(ms){ return ms >= 1000 ? (ms/1000).toFixed(1) + 's' : ms + 'ms'; }
function fmtTime(iso){ const d = new Date(iso); return d.toLocaleString(); }
function bandFor(u){ return u >= 90 ? ['Critical','red','var(--red)'] : u >= 80 ? ['Warning','orange','var(--orange)'] : u >= 60 ? ['Elevated','yellow','var(--yellow)'] : ['Healthy','green','var(--green)']; }
`;

function layout(title: string, active: string, body: string, script: string): string {
  const navItems = [
    ["", "Dashboard"],
    ["/requests", "Requests"],
    ["/errors", "Errors"],
    ["/controls", "Controls"],
  ]
    .map(
      ([path, label]) =>
        `<a data-nav="${path}"${label === active ? ' class="active"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — PayerNews Admin</title><style>${STYLE}</style></head>
<body>
<header>
  <span class="brand">PayerNews Scraper <span class="muted">/ Admin</span></span>
  <nav>${navItems}</nav>
  <span style="flex:1"></span>
  <button id="logout-btn" type="button">Logout</button>
</header>
<main>${body}</main>
<script>
${BASE_SCRIPT}
document.getElementById('logout-btn').onclick = async () => {
  try {
    const me = await api('/me');
    await fetch(CONSOLE + '/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken } });
  } catch (e) {}
  location.href = CONSOLE + '/login';
};
${script}
</script>
</body></html>`;
}

/** Tiny page that redirects client-side (mount- and proxy-prefix safe). */
function redirectPage(consoleSubPath: string): string {
  return `<!doctype html><script>var m=location.pathname.match(/^(.*?)(\\/api\\/admin-console|\\/admin)(\\/|$)/);location.href=(m?m[1]+m[2]:'/admin')+'${consoleSubPath}';</script>`;
}

// ── Login / logout ────────────────────────────────────────────────────────────

function loginPage(errorMsg?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — PayerNews Admin</title><style>${STYLE}</style></head>
<body><div class="login-wrap"><div class="login-box">
<h1>PayerNews Scraper</h1><p>Admin console — sign in to continue</p>
${errorMsg ? `<div class="error-msg">${errorMsg}</div>` : ""}
<form method="post" action="">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit" class="primary">Sign In</button>
</form>
</div></div></body></html>`;
}

router.get("/login", (_req, res) => {
  if (!isAdminConfigured()) {
    res
      .status(503)
      .type("html")
      .send(
        `<!doctype html><style>${STYLE}</style><div class="login-wrap"><div class="login-box"><h1>Admin console not configured</h1><p>Set the <b>ADMIN_USERNAME</b>, <b>ADMIN_PASSWORD_HASH</b>, and <b>SESSION_SECRET</b> secrets, then restart the server.</p></div></div>`,
      );
    return;
  }
  res.type("html").send(loginPage());
});

router.post("/login", async (req: Request, res: Response) => {
  if (!isAdminConfigured()) {
    res.status(503).type("html").send(loginPage("Admin console is not configured."));
    return;
  }
  const ip = req.ip ?? "unknown";
  if (isLockedOut(ip)) {
    res
      .status(429)
      .type("html")
      .send(loginPage("Too many failed attempts. Try again later."));
    return;
  }

  const body = req.body as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  const ok = await verifyCredentials(username, password);
  if (!ok) {
    recordLoginFailure(ip);
    res.status(401).type("html").send(loginPage("Invalid username or password."));
    return;
  }

  clearLoginFailures(ip);
  const session = createSession(username);
  logger.info({ username }, "Admin login successful");

  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    signed: true,
    maxAge: config.adminSessionHours * 3600 * 1000,
  });
  res.type("html").send(redirectPage(""));
});

router.post("/logout", (req: AdminRequest, res) => {
  const signed = (req as AdminRequest & { signedCookies?: Record<string, string> })
    .signedCookies;
  const sessionId = signed?.[SESSION_COOKIE];
  const session = sessionId ? getSession(sessionId) : undefined;
  if (session) {
    // CSRF-protect logout like every other state-changing POST.
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || token !== session.csrfToken) {
      res.status(403).json({ success: false, error: "Invalid CSRF token" });
      return;
    }
    destroySession(sessionId);
  }
  res.clearCookie(SESSION_COOKIE);
  res.type("html").send(redirectPage("/login"));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get("/", requireAdminPage, (_req, res) => {
  const body = `
<div id="alert-banner" class="banner"></div>
<h1>Dashboard <span id="svc-badge" class="badge gray">…</span> <span id="mode-badge"></span></h1>
<div class="cards">
  <div class="card"><h2>Service Health</h2>
    <div class="kv"><span>Status</span><span id="h-status">—</span></div>
    <div class="kv"><span>Accepting requests</span><span id="h-accepting">—</span></div>
    <div class="kv"><span>Browser running</span><span id="h-browser">—</span></div>
    <div class="kv"><span>Last refresh</span><span id="h-refresh">—</span></div>
  </div>
  <div class="card"><h2>Browser Pool</h2>
    <div class="kv"><span>Active contexts</span><span id="p-active">—</span></div>
    <div class="kv"><span>Queued jobs</span><span id="p-queued">—</span></div>
    <div class="kv"><span>Warning threshold</span><span id="p-warn">—</span></div>
    <div class="bar"><div id="p-bar"></div></div>
    <div class="kv"><span>Utilization</span><span id="p-util">—</span></div>
  </div>
  <div class="card"><h2>Today</h2>
    <div class="big" id="s-today">—</div><div class="muted">scrapes today</div>
    <div class="kv"><span>Successes</span><span id="s-succ">—</span></div>
    <div class="kv"><span>Failures</span><span id="s-fail">—</span></div>
    <div class="kv"><span>Static / Playwright</span><span id="s-split">—</span></div>
  </div>
  <div class="card"><h2>Performance (7 days)</h2>
    <div class="kv"><span>Last 24h / week</span><span id="s-window">—</span></div>
    <div class="kv"><span>Success rate</span><span id="s-rate">—</span></div>
    <div class="kv"><span>Playwright fallback rate</span><span id="s-fallback">—</span></div>
    <div class="kv"><span>Avg / median duration</span><span id="s-dur">—</span></div>
    <div class="kv"><span>Longest duration</span><span id="s-max">—</span></div>
  </div>
</div>
<h2>Recent scrapes</h2>
<table><thead><tr><th>Time</th><th>Request ID</th><th>Domain</th><th>Route</th><th>Result</th><th>Scraper</th><th>Duration</th><th>Content</th></tr></thead>
<tbody id="recent-body"><tr class="norow"><td colspan="8" class="muted">Loading…</td></tr></tbody></table>
<p class="footnote">Metrics refresh every 6 seconds. <a data-nav="/requests">Full request history →</a></p>`;

  const script = `
function badge(el, text, cls){ el.textContent = text; el.className = 'badge ' + cls; }
async function refreshStatus(){
  try{
    const s = await api('/status');
    const p = s.browserPool;
    badge(document.getElementById('svc-badge'), s.serviceStatus === 'healthy' ? 'Healthy' : 'Degraded', s.serviceStatus === 'healthy' ? 'green' : 'orange');
    const modeEl = document.getElementById('mode-badge');
    if (s.mode !== 'normal') badge(modeEl, s.mode === 'paused' ? 'PAUSED' : 'DRAINING', 'red'); else { modeEl.textContent=''; modeEl.className=''; }
    document.getElementById('h-status').textContent = s.serviceStatus;
    document.getElementById('h-accepting').textContent = s.acceptingRequests ? 'Yes' : 'No';
    document.getElementById('h-browser').textContent = p.browserRunning ? 'Yes' : 'No';
    document.getElementById('h-refresh').textContent = new Date().toLocaleTimeString();
    document.getElementById('p-active').textContent = p.active + ' / ' + p.maxContexts;
    document.getElementById('p-queued').textContent = p.queued + ' / ' + p.maxQueue;
    document.getElementById('p-warn').textContent = p.warnThresholdPct + '%';
    const [label,, color] = bandFor(p.utilisation);
    const bar = document.getElementById('p-bar');
    bar.style.width = Math.min(p.utilisation, 100) + '%'; bar.style.background = color;
    document.getElementById('p-util').textContent = p.utilisation + '% — ' + label;
    const banner = document.getElementById('alert-banner');
    const qPct = p.maxQueue > 0 ? Math.round(p.queued / p.maxQueue * 100) : 0;
    if (p.utilisation >= 90 || qPct >= 90) {
      banner.className = 'banner crit';
      banner.textContent = 'CRITICAL — pool utilization ' + p.utilisation + '%; ' + p.queued + ' of ' + p.maxQueue + ' queue slots occupied.';
    } else if (p.utilisation >= p.warnThresholdPct) {
      banner.className = 'banner warn';
      banner.textContent = 'WARNING — pool utilization is ' + p.utilisation + '%. ' + p.queued + ' of ' + p.maxQueue + ' queue slots occupied.';
    } else banner.className = 'banner';
    if (s.statistics) {
      document.getElementById('s-today').textContent = s.statistics.scrapesToday;
      document.getElementById('s-succ').textContent = s.statistics.successesToday;
      document.getElementById('s-fail').textContent = s.statistics.failuresToday;
      document.getElementById('s-split').textContent = s.statistics.staticSuccessesToday + ' / ' + s.statistics.playwrightSuccessesToday;
    }
  }catch(e){ /* transient */ }
}
async function refreshStats(){
  try{
    const s = await api('/stats');
    document.getElementById('s-window').textContent = s.scrapesLast24h + ' / ' + s.scrapesThisWeek;
    document.getElementById('s-rate').textContent = s.successRatePct + '%';
    document.getElementById('s-fallback').textContent = s.playwrightFallbackRatePct + '%';
    document.getElementById('s-dur').textContent = fmtDur(s.averageDurationMs) + ' / ' + fmtDur(s.medianDurationMs);
    document.getElementById('s-max').textContent = fmtDur(s.longestDurationMs);
  }catch(e){}
}
async function refreshRecent(){
  try{
    const d = await api('/requests?limit=15');
    const tb = document.getElementById('recent-body');
    tb.textContent = '';
    if (!d.rows.length) { tb.innerHTML = '<tr class="norow"><td colspan="8" class="muted">No scrape requests logged yet.</td></tr>'; return; }
    for (const r of d.rows) {
      const tr = document.createElement('tr');
      tr.onclick = () => location.href = CONSOLE + '/requests/' + r.requestId;
      const cells = [
        new Date(r.createdAt).toLocaleTimeString(),
        r.requestId, r.domain || '—', r.route || '—',
        r.success ? 'Success' : 'Failed',
        r.scraperUsed || '—', fmtDur(r.durationMs), r.contentLength.toLocaleString()
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 4) { const b = document.createElement('span'); b.className = 'badge ' + (r.success ? 'green' : 'red'); b.textContent = c; td.appendChild(b); }
        else td.textContent = c;
        if (i === 1) td.className = 'mono';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
  }catch(e){}
}
refreshStatus(); refreshStats(); refreshRecent();
setInterval(refreshStatus, 6000);
setInterval(refreshStats, 30000);
setInterval(refreshRecent, 15000);`;

  res.type("html").send(layout("Dashboard", "Dashboard", body, script));
});

// ── Requests list / errors ────────────────────────────────────────────────────

function requestsPage(errorsOnly: boolean): { body: string; script: string } {
  const title = errorsOnly ? "Errors" : "Requests";
  const body = `
<h1>${errorsOnly ? "Error Dashboard" : "Request History"}</h1>
<div class="filters">
  <input id="f-search" placeholder="Search request ID, URL, domain…" style="min-width:240px">
  ${
    errorsOnly
      ? ""
      : `<select id="f-result"><option value="">All results</option><option value="success">Success</option><option value="failure">Failure</option></select>`
  }
  <select id="f-scraper"><option value="">All scrapers</option><option value="static">Static</option><option value="playwright">Playwright</option></select>
  <input id="f-domain" placeholder="Domain" style="width:150px">
  <input id="f-route" placeholder="Route" style="width:110px">
  <button id="f-apply" class="primary">Apply</button>
  <button id="f-clear">Clear</button>
</div>
<table><thead><tr><th>Time</th><th>Request ID</th><th>Domain</th><th>Route</th><th>Result</th><th>Scraper</th><th>Status</th><th>Duration</th><th>${errorsOnly ? "Error" : "Content"}</th></tr></thead>
<tbody id="rows"><tr class="norow"><td colspan="9" class="muted">Loading…</td></tr></tbody></table>
<div class="pager">
  <button id="pg-prev">‹ Prev</button>
  <span id="pg-info">—</span>
  <button id="pg-next">Next ›</button>
</div>`;

  const script = `
let page = 1;
function params(){
  const p = new URLSearchParams();
  const v = id => document.getElementById(id) ? document.getElementById(id).value.trim() : '';
  if (v('f-search')) p.set('search', v('f-search'));
  ${errorsOnly ? "p.set('errorsOnly','true');" : "if (v('f-result')) p.set('result', v('f-result'));"}
  if (v('f-scraper')) p.set('scraper', v('f-scraper'));
  if (v('f-domain')) p.set('domain', v('f-domain'));
  if (v('f-route')) p.set('route', v('f-route'));
  p.set('page', page); p.set('limit', 25);
  return p.toString();
}
async function load(){
  const d = await api('/requests?' + params());
  const tb = document.getElementById('rows');
  tb.textContent = '';
  if (!d.rows.length) { tb.innerHTML = '<tr class="norow"><td colspan="9" class="muted">No matching requests.</td></tr>'; }
  for (const r of d.rows) {
    const tr = document.createElement('tr');
    tr.onclick = () => location.href = CONSOLE + '/requests/' + r.requestId;
    const cells = [
      fmtTime(r.createdAt), r.requestId, r.domain || '—', r.route || '—',
      r.success ? 'Success' : 'Failed', r.scraperUsed || '—',
      r.httpStatus || '—', fmtDur(r.durationMs),
      ${errorsOnly ? "(r.errorMessage || '—')" : "r.contentLength.toLocaleString()"}
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (i === 4) { const b = document.createElement('span'); b.className = 'badge ' + (r.success ? 'green' : 'red'); b.textContent = c; td.appendChild(b); }
      else td.textContent = c;
      if (i === 1) td.className = 'mono';
      if (i === 8) { td.className = 'url'; td.title = c; }
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  document.getElementById('pg-info').textContent = 'Page ' + d.page + ' of ' + d.pageCount + ' — ' + d.total.toLocaleString() + ' requests';
  document.getElementById('pg-prev').disabled = d.page <= 1;
  document.getElementById('pg-next').disabled = d.page >= d.pageCount;
}
document.getElementById('f-apply').onclick = () => { page = 1; load(); };
document.getElementById('f-clear').onclick = () => { document.querySelectorAll('.filters input,.filters select').forEach(e => e.value = ''); page = 1; load(); };
document.getElementById('f-search').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; load(); } });
document.getElementById('pg-prev').onclick = () => { if (page > 1) { page--; load(); } };
document.getElementById('pg-next').onclick = () => { page++; load(); };
load();`;
  return { body, script };
}

router.get("/requests", requireAdminPage, (_req, res) => {
  const { body, script } = requestsPage(false);
  res.type("html").send(layout("Requests", "Requests", body, script));
});

router.get("/errors", requireAdminPage, (_req, res) => {
  const { body, script } = requestsPage(true);
  res.type("html").send(layout("Errors", "Errors", body, script));
});

// ── Request detail ────────────────────────────────────────────────────────────

router.get("/requests/:requestId", requireAdminPage, (req, res) => {
  const body = `
<p><a data-nav="/requests">← Back to requests</a></p>
<h1 class="mono" id="d-title">Request</h1>
<div class="cards">
  <div class="card"><h2>Result</h2><div id="d-result"></div>
    <div class="kv"><span>HTTP status</span><span id="d-status">—</span></div>
    <div class="kv"><span>Scraper used</span><span id="d-scraper">—</span></div>
    <div class="kv"><span>Playwright fallback</span><span id="d-fallback">—</span></div>
    <div class="kv"><span>Duration</span><span id="d-duration">—</span></div>
    <div class="kv"><span>Content length</span><span id="d-length">—</span></div>
  </div>
  <div class="card"><h2>Request</h2>
    <div class="kv"><span>Timestamp</span><span id="d-time">—</span></div>
    <div class="kv"><span>Route</span><span id="d-route">—</span></div>
    <div class="kv"><span>Domain</span><span id="d-domain">—</span></div>
    <div class="kv"><span>Queue depth at start</span><span id="d-queue">—</span></div>
    <div class="kv"><span>Active contexts at start</span><span id="d-active">—</span></div>
  </div>
</div>
<div class="card detail" style="margin-bottom:16px">
  <dt>Original URL</dt><dd class="mono" id="d-url" style="word-break:break-all">—</dd>
  <dt>Final URL</dt><dd class="mono" id="d-final" style="word-break:break-all">—</dd>
  <dt>Error message</dt><dd id="d-error">—</dd>
</div>
<div class="card" id="d-preview-card" style="display:none"><h2>Content preview (first 500 chars)</h2><pre id="d-preview"></pre></div>
<p class="muted" id="d-notfound" style="display:none">Request not found — it may have been pruned by retention.</p>`;

  const script = `
const reqId = decodeURIComponent(location.pathname.split('/').pop());
document.getElementById('d-title').textContent = reqId;
(async () => {
  const r = await fetch(API + '/requests/' + encodeURIComponent(reqId));
  if (r.status === 401) { location.href = CONSOLE + '/login'; return; }
  if (r.status === 404) { document.getElementById('d-notfound').style.display = 'block'; return; }
  const d = await r.json();
  const set = (id, v) => document.getElementById(id).textContent = v;
  const res = document.getElementById('d-result');
  const b = document.createElement('span'); b.className = 'badge ' + (d.success ? 'green' : 'red');
  b.textContent = d.success ? 'Success' : 'Failed'; res.appendChild(b);
  set('d-status', d.httpStatus || '—'); set('d-scraper', d.scraperUsed || '—');
  set('d-fallback', d.playwrightFallback ? 'Yes' : 'No');
  set('d-duration', fmtDur(d.durationMs)); set('d-length', d.contentLength.toLocaleString());
  set('d-time', fmtTime(d.createdAt)); set('d-route', d.route || '—'); set('d-domain', d.domain || '—');
  set('d-queue', d.queueDepthAtStart); set('d-active', d.activeContextsAtStart);
  set('d-url', d.url); set('d-final', d.finalUrl || '—'); set('d-error', d.errorMessage || '—');
  if (d.contentPreview) {
    document.getElementById('d-preview-card').style.display = 'block';
    document.getElementById('d-preview').textContent = d.contentPreview;
  }
})();`;
  // requestId comes from the URL path — escape before interpolating.
  res.type("html").send(layout(`Request ${escapeHtml(String(req.params.requestId))}`, "Requests", body, script));
});

// ── Controls ──────────────────────────────────────────────────────────────────

router.get("/controls", requireAdminPage, (_req, res) => {
  const body = `
<h1>Admin Controls</h1>
<div class="card" style="margin-bottom:16px">
  <h2>Current state</h2>
  <div class="kv"><span>Mode</span><span id="c-mode">—</span></div>
  <div class="kv"><span>Accepting new requests</span><span id="c-accepting">—</span></div>
  <div class="kv"><span>Active / queued jobs</span><span id="c-jobs">—</span></div>
  <div class="kv"><span>Last change</span><span id="c-changed">—</span></div>
</div>
<div class="cards">
  <div class="card"><h2>Pause</h2>
    <p class="muted" style="margin-bottom:12px">Reject new scrape requests with HTTP 503 (<span class="mono">status: "paused"</span>). Active and queued jobs continue processing. Power Automate should retry later.</p>
    <button id="btn-pause" class="warning">Pause New Scrape Requests</button></div>
  <div class="card"><h2>Drain</h2>
    <p class="muted" style="margin-bottom:12px">Stop accepting new jobs while everything already active or queued finishes naturally. Nothing is deleted or cancelled.</p>
    <button id="btn-drain" class="danger">Enter Drain Mode</button></div>
  <div class="card"><h2>Resume</h2>
    <p class="muted" style="margin-bottom:12px">Return to normal operation and accept new scrape requests again.</p>
    <button id="btn-resume" class="primary">Resume Scraping</button></div>
</div>
<p class="footnote">All controls are POST-only, CSRF-protected, and never discard queued work. There is intentionally no destructive queue-flush.</p>
<p id="c-msg" class="footnote"></p>`;

  const script = `
let csrf = null;
async function refresh(){
  try{
    const [me, s] = await Promise.all([api('/me'), api('/status')]);
    csrf = me.csrfToken;
    document.getElementById('c-mode').textContent = s.mode;
    document.getElementById('c-accepting').textContent = s.acceptingRequests ? 'Yes' : 'No';
    document.getElementById('c-jobs').textContent = s.browserPool.active + ' active / ' + s.browserPool.queued + ' queued';
    document.getElementById('c-changed').textContent = s.modeChangedAt ? fmtTime(s.modeChangedAt) : '—';
    document.getElementById('btn-pause').disabled = s.mode === 'paused';
    document.getElementById('btn-drain').disabled = s.mode === 'drain';
    document.getElementById('btn-resume').disabled = s.mode === 'normal';
  }catch(e){}
}
async function act(action, confirmMsg){
  if (!confirm(confirmMsg)) return;
  const r = await fetch(API + '/controls/' + action, { method: 'POST', headers: { 'x-csrf-token': csrf } });
  const d = await r.json().catch(() => ({}));
  document.getElementById('c-msg').textContent = r.ok ? ('Done — mode is now "' + d.mode + '".') : ('Failed: ' + (d.error || r.status));
  refresh();
}
document.getElementById('btn-pause').onclick = () => act('pause', 'Pause all NEW scrape requests? Active and queued jobs will continue.');
document.getElementById('btn-drain').onclick = () => act('drain', 'Enter drain mode? New jobs are rejected while existing work finishes.');
document.getElementById('btn-resume').onclick = () => act('resume', 'Resume accepting new scrape requests?');
refresh();
setInterval(refresh, 8000);`;
  res.type("html").send(layout("Controls", "Controls", body, script));
});

export default router;
