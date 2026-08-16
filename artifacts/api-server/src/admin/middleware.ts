/**
 * Auth middleware for the admin console — separate from the API bearer auth.
 */

import type { Request, Response, NextFunction } from "express";
import { getSession, SESSION_COOKIE, type AdminSession } from "./sessions.js";

export interface AdminRequest extends Request {
  adminSession?: AdminSession;
}

function sessionFromRequest(req: Request): AdminSession | null {
  const signed = (req as Request & { signedCookies?: Record<string, string> })
    .signedCookies;
  return getSession(signed?.[SESSION_COOKIE]);
}

/**
 * Protects HTML pages under /admin — unauthenticated users get a tiny page
 * that client-side-redirects to the login page.  (Client-side because the
 * dev proxy may serve this app under a path prefix the server cannot see.)
 */
export function requireAdminPage(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): void {
  const session = sessionFromRequest(req);
  if (!session) {
    res
      .status(401)
      .type("html")
      .send(
        `<!doctype html><script>var m=location.pathname.match(/^(.*?)(\\/api\\/admin-console|\\/admin)(\\/|$)/);location.href=(m?m[1]+m[2]:'/admin')+'/login';</script>`,
      );
    return;
  }
  req.adminSession = session;
  next();
}

/** Protects JSON admin API endpoints — 401 JSON when unauthenticated. */
export function requireAdminApi(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): void {
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ success: false, error: "Not authenticated" });
    return;
  }
  req.adminSession = session;
  next();
}

/**
 * CSRF guard for state-changing admin POSTs.
 * Requires header `x-csrf-token` (or body field `_csrf`) matching the
 * token bound to the session.  Must run after requireAdminApi/Page.
 */
export function requireCsrf(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): void {
  const session = req.adminSession;
  const provided =
    (req.headers["x-csrf-token"] as string | undefined) ??
    (req.body as Record<string, unknown> | undefined)?.["_csrf"];
  if (!session || typeof provided !== "string" || provided !== session.csrfToken) {
    res.status(403).json({ success: false, error: "Invalid CSRF token" });
    return;
  }
  next();
}
