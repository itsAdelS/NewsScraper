/**
 * Operational state for the scraper — controlled from the admin console.
 *
 *   normal — accepting new scrape requests (default)
 *   paused — new requests rejected with 503 `status: "paused"`
 *   drain  — new requests rejected; active/queued jobs finish naturally
 *
 * Pause/drain NEVER cancels in-flight or queued work — it only stops new
 * requests from being accepted at the route level.  State is in-memory and
 * resets to "normal" on process restart (safe default).
 */

import { logger } from "./logger.js";

export type OpsMode = "normal" | "paused" | "drain";

interface OpsState {
  mode: OpsMode;
  changedAt: string; // ISO timestamp of last mode change
}

const state: OpsState = {
  mode: "normal",
  changedAt: new Date().toISOString(),
};

export function getOpsState(): OpsState & { acceptingRequests: boolean } {
  return { ...state, acceptingRequests: state.mode === "normal" };
}

export function setOpsMode(mode: OpsMode, changedBy: string): void {
  if (state.mode === mode) return;
  const previous = state.mode;
  state.mode = mode;
  state.changedAt = new Date().toISOString();
  logger.warn(
    { previous, mode, changedBy },
    "Ops state changed by administrator",
  );
}
