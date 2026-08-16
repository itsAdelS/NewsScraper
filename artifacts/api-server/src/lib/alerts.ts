/**
 * Alert-state machine for browser-pool utilisation.
 *
 * States: healthy → warning → critical → recovered → healthy
 *
 *   warning:   utilisation >= poolWarnThreshold (default 80%)
 *   critical:  utilisation >= 90%
 *   recovered: utilisation fell below 60% after warning/critical
 *   healthy:   recovered held for RECOVERED_HOLD_MS
 *
 * Transitions are logged exactly once (state-change based, not per-sample),
 * which acts as the cooldown mechanism.  A Power Automate flow or webhook
 * can poll GET /api/admin/alerts to consume this state.
 */

import { browserPool } from "../scrapers/browser-pool.js";
import { config } from "../config.js";
import { logger } from "./logger.js";

export type AlertState = "healthy" | "warning" | "critical" | "recovered";

const SAMPLE_INTERVAL_MS = 5_000;
const RECOVERED_HOLD_MS = 60_000;
const RECOVERY_FLOOR_PCT = 60;
const CRITICAL_PCT = 90;

let currentState: AlertState = "healthy";
let lastStateChange = new Date().toISOString();
let recoveredSince = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function utilisationPct(): number {
  const { active } = browserPool.stats;
  const max = config.playwrightMaxContexts;
  return max > 0 ? Math.round((active / max) * 100) : 0;
}

function transition(next: AlertState, utilisation: number): void {
  if (next === currentState) return;
  const previous = currentState;
  currentState = next;
  lastStateChange = new Date().toISOString();
  const { queued } = browserPool.stats;
  logger.warn(
    { previous, state: next, utilisation, queued, maxQueue: config.playwrightQueueLimit },
    "Alert state transition",
  );
}

function sample(): void {
  const util = utilisationPct();
  const warnPct = Math.round(config.poolWarnThreshold * 100);

  if (util >= CRITICAL_PCT) {
    transition("critical", util);
    return;
  }
  if (util >= warnPct) {
    transition("warning", util);
    return;
  }
  if (
    (currentState === "warning" || currentState === "critical") &&
    util < RECOVERY_FLOOR_PCT
  ) {
    recoveredSince = Date.now();
    transition("recovered", util);
    return;
  }
  if (
    currentState === "recovered" &&
    Date.now() - recoveredSince >= RECOVERED_HOLD_MS
  ) {
    transition("healthy", util);
  }
}

/** Begin periodic sampling. Safe to call once at boot. */
export function startAlertMonitor(): void {
  if (timer) return;
  timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref();
}

export function getAlertStatus(): {
  currentState: AlertState;
  utilisation: number;
  queued: number;
  maxQueue: number;
  lastStateChange: string;
} {
  return {
    currentState,
    utilisation: utilisationPct(),
    queued: browserPool.stats.queued,
    maxQueue: config.playwrightQueueLimit,
    lastStateChange,
  };
}
