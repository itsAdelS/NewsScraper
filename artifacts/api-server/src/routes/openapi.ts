/**
 * GET /api/openapi.yaml
 *
 * Serves the OpenAPI 3.0 specification for this API.
 * No authentication required — APIM and API consumers need this file
 * to import and configure the API definition.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();

// Resolve path relative to the compiled output (dist/index.mjs).
// Works in both dev (tsx) and production (node dist/index.mjs).
const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../openapi.yaml",
);

let specCache: string | null = null;

router.get("/openapi.yaml", (_req: Request, res: Response) => {
  try {
    // Cache the file content after the first read so we don't hit disk
    // on every request, but still allow the file to be updated on disk
    // in development without restarting the server (cache is per-process).
    if (!specCache) {
      specCache = readFileSync(SPEC_PATH, "utf-8");
    }
    res.setHeader("Content-Type", "application/yaml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300"); // 5 min
    res.status(200).send(specCache);
  } catch {
    res
      .status(503)
      .json({ success: false, error: "OpenAPI spec file not available" });
  }
});

export default router;
