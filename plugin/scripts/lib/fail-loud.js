/**
 * Sprintra Memory Layer Phase 6 — Fail-loud counter + stderr warning.
 *
 * Today, hook failures are silent (debug log only). Founder went 6 days
 * without knowing capture was broken. This module surfaces a visible
 * warning when consecutive sync failures exceed a threshold.
 *
 * Threshold: 10 (gentler than claude-mem's 3 — SaaS networks flap; killing
 * the user's Claude Code conversation over a 30-second deploy outage is
 * hostile). Rate-limited to max 1 warning per hour.
 *
 * Story: VP-1300. Spec: doc-7N8zPoZC.
 */

import { getFailureStats, recordFailure, recordSuccess, openBuffer } from "./buffer-sqlite.js";

export const DEFAULT_THRESHOLD = 10;
export const WARNING_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

const HINTS = {
  auth_failed: "Run `sprintra login` to refresh your token.",
  network_error: "Check your network connection.",
  server_error: "api.sprintra.io is having issues — events safely buffered locally.",
  buffer_full_hard_cap: "Local buffer hit hard cap. Free disk space and run `sprintra drain`.",
  unknown: "Run `sprintra status` to diagnose.",
};

/**
 * Get the configured threshold. Override via SPRINTRA_FAIL_LOUD_THRESHOLD env.
 */
export function getThreshold() {
  const env = parseInt(process.env.SPRINTRA_FAIL_LOUD_THRESHOLD ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_THRESHOLD;
}

/**
 * Surface a stderr warning if consecutive failures exceed threshold AND
 * we haven't surfaced one in the last hour.
 *
 * Returns true if a warning was emitted.
 */
export async function maybeSurfaceWarning(reason = "unknown") {
  const stats = await getFailureStats();
  if (!stats) return false;
  const threshold = getThreshold();
  if ((stats.consecutive_failures ?? 0) < threshold) return false;

  const now = Date.now();
  const lastWarn = stats.last_warning_at ?? 0;
  if (now - lastWarn < WARNING_RATE_LIMIT_MS) return false;

  // Update last_warning_at atomically
  const db = await openBuffer();
  db.prepare("UPDATE hook_failures SET last_warning_at = ? WHERE id = 1").run(now);

  const hint = HINTS[reason] ?? HINTS.unknown;
  const msg = [
    "",
    `⚠ Sprintra capture is degraded — last ${stats.consecutive_failures} sync attempts failed.`,
    `  Reason: ${reason}`,
    `  Hint:   ${hint}`,
    `  Events are safely buffered locally and will sync when the issue resolves.`,
    "",
  ].join("\n");
  process.stderr.write(msg);
  return true;
}

/**
 * Convenience wrapper: record a failure, then maybe-surface warning.
 */
export async function recordFailureAndMaybeWarn(reason = "unknown") {
  await recordFailure(reason);
  await maybeSurfaceWarning(reason);
}

/**
 * Reset the counter on successful drain.
 */
export async function recordDrainSuccess() {
  await recordSuccess();
}
