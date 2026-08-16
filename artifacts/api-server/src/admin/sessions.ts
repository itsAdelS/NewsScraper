/**
 * Admin session management + credential verification + brute-force limiter.
 *
 * Completely separate from the API bearer-token auth (middleware/auth.ts).
 *
 * - Sessions are in-memory, keyed by a 256-bit random ID delivered in a
 *   signed (SESSION_SECRET), HttpOnly, SameSite=Lax cookie.
 * - Sliding expiry: each authenticated request extends the session up to
 *   `config.adminSessionHours` (default 8h) from last activity.
 * - Credentials come from ADMIN_USERNAME + ADMIN_PASSWORD_HASH (bcrypt).
 * - Brute-force: max `adminLoginMaxAttempts` failures per IP per
 *   `adminLoginWindowMinutes`; further attempts are rejected during window.
 * - Passwords are never logged and never returned by any endpoint.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export const SESSION_COOKIE = "pn_admin_session";

export interface AdminSession {
  id: string;
  username: string;
  csrfToken: string;
  expiresAt: number;
}

const sessions = new Map<string, AdminSession>();

function sessionTtlMs(): number {
  return config.adminSessionHours * 3600 * 1000;
}

export function isAdminConfigured(): boolean {
  return Boolean(
    process.env.ADMIN_USERNAME &&
      process.env.ADMIN_PASSWORD_HASH &&
      process.env.SESSION_SECRET,
  );
}

export function createSession(username: string): AdminSession {
  pruneExpired();
  const session: AdminSession = {
    id: randomBytes(32).toString("hex"),
    username,
    csrfToken: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + sessionTtlMs(),
  };
  sessions.set(session.id, session);
  return session;
}

/** Look up a session by ID; extends expiry (sliding window) when valid. */
export function getSession(id: string | undefined): AdminSession | null {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  s.expiresAt = Date.now() + sessionTtlMs();
  return s;
}

export function destroySession(id: string | undefined): void {
  if (id) sessions.delete(id);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}

// ── Credential verification ───────────────────────────────────────────────────

/**
 * Verify username + password against ADMIN_USERNAME / ADMIN_PASSWORD_HASH.
 * Always runs a bcrypt comparison (even on username mismatch) so response
 * timing does not reveal which field was wrong.
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  const expectedUser = process.env.ADMIN_USERNAME ?? "";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH ?? "";
  if (!expectedUser || !passwordHash) return false;

  const userOk = constantTimeEquals(username, expectedUser);
  // Compare against the real hash regardless, to equalise timing.
  const passOk = await bcrypt.compare(password, passwordHash).catch(() => false);
  return userOk && passOk;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare anyway to keep timing flat, then fail.
    timingSafeEqual(Buffer.alloc(bb.length || 1), Buffer.alloc(bb.length || 1));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ── Brute-force limiter (per IP) ──────────────────────────────────────────────

const failuresByIp = new Map<string, number[]>();

function windowMs(): number {
  return config.adminLoginWindowMinutes * 60 * 1000;
}

export function isLockedOut(ip: string): boolean {
  const cutoff = Date.now() - windowMs();
  const recent = (failuresByIp.get(ip) ?? []).filter((t) => t > cutoff);
  failuresByIp.set(ip, recent);
  return recent.length >= config.adminLoginMaxAttempts;
}

export function recordLoginFailure(ip: string): void {
  const cutoff = Date.now() - windowMs();
  const recent = (failuresByIp.get(ip) ?? []).filter((t) => t > cutoff);
  recent.push(Date.now());
  failuresByIp.set(ip, recent);
  logger.warn(
    { ip, recentFailures: recent.length },
    "Failed admin login attempt",
  );
}

export function clearLoginFailures(ip: string): void {
  failuresByIp.delete(ip);
}
