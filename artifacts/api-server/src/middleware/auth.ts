/**
 * API key authentication middleware for the scraper API.
 *
 * Expects: Authorization: Bearer <PAYERNEWS_API_KEY>
 *
 * Returns HTTP 401 for missing or invalid credentials.
 * Never logs the key value.
 */

import type { Request, Response, NextFunction } from "express";

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = process.env.PAYERNEWS_API_KEY;

  if (!apiKey) {
    // API key not configured on the server — refuse all requests.
    res.status(401).json({
      success: false,
      error:
        "API authentication is not configured. Set the PAYERNEWS_API_KEY environment variable.",
    });
    return;
  }

  const authHeader = req.headers.authorization ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: "Missing or malformed Authorization header. Expected: Bearer <token>",
    });
    return;
  }

  const providedKey = authHeader.slice("Bearer ".length).trim();

  // Use a timing-safe comparison to avoid timing-oracle attacks.
  if (!timingSafeEqual(providedKey, apiKey)) {
    res.status(401).json({ success: false, error: "Invalid API key" });
    return;
  }

  next();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate to prevent length-based timing leak.
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return false; // Length mismatch is always invalid.
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
