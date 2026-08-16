import app from "./app";
import { logger } from "./lib/logger";
import { browserPool } from "./scrapers/browser-pool";
import { startAlertMonitor } from "./lib/alerts";
import { startRetentionPruning } from "./lib/request-log";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Admin console background services: pool alert-state machine and
// request-log retention pruning.
startAlertMonitor();
startRetentionPruning();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Close the shared Chromium browser before the process exits so no orphan
// processes remain after a restart or deployment swap.
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Server shutting down — draining browser pool");
  try {
    await browserPool.shutdown();
  } catch (err) {
    logger.warn({ err }, "Error during browser pool shutdown");
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
