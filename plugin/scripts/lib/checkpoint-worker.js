/**
 * Sprintra Memory Layer Phase 6 — Opportunistic checkpoint worker.
 *
 * Story: VP-1294. Spec: doc-7N8zPoZC.
 *
 * Instead of running a long-lived daemon (which adds install friction —
 * port management, PID files, healthchecks), we piggyback on the user's
 * own activity: every hook invocation checks "has it been ≥60s since the
 * last checkpoint for this session? If yes, enqueue a checkpoint event."
 *
 * If the user is idle, no checkpoints fire — which is correct, because
 * there's nothing happening to snapshot. As soon as they resume activity,
 * the next hook fires a checkpoint within seconds.
 *
 * Trade-off: bursts of rapid hook fires won't fire 1 checkpoint per
 * sub-60s tool call (we cap at 1/60s). Sustained quiet periods fall
 * behind, but only by however long the quiet period was — bounded by
 * "≤60s since last hook fire" once activity resumes.
 *
 * For users who want strict 60s-wallclock checkpoints regardless of hook
 * activity (e.g., paid Team tier where we want minute-resolution status),
 * a future story can add an opt-in `sprintra daemon start` lifecycle.
 */

import { openBuffer, enqueueEvent } from "./buffer-sqlite.js";

export const CHECKPOINT_INTERVAL_MS = 60 * 1000; // 60s

/**
 * Ensure the heartbeat row has a per-session checkpoint tracker.
 * We piggyback on session_seq (already created in v1) and add a checkpoint
 * column there. Migration is idempotent.
 */
async function ensureCheckpointColumns() {
  const db = await openBuffer();
  for (const stmt of [
    "ALTER TABLE session_seq ADD COLUMN last_checkpoint_at INTEGER",
  ]) {
    try {
      db.prepare(stmt).run();
    } catch (e) {
      if (!String(e).includes("duplicate column")) {
        // Genuine migration error — log but don't crash; checkpoints will be
        // a no-op if the column is missing.
      }
    }
  }
}

/**
 * Maybe fire a checkpoint event for this session.
 *
 * Returns:
 *   { fired: boolean, reason: string }
 *
 * Called from any hook (UserPromptSubmit, PostToolUse, Stop) at the END
 * of the hook's main work. Cheap — one indexed SELECT + maybe one
 * UPDATE + one INSERT.
 */
export async function maybeFireCheckpoint({
  session_id,
  source,
  project_id,
  user_id,
  cwd,
  extra_payload = {},
}) {
  if (!session_id) return { fired: false, reason: "no_session_id" };

  await ensureCheckpointColumns();
  const db = await openBuffer();
  const now = Date.now();

  // Get last checkpoint time for this session
  const row = db
    .prepare("SELECT last_checkpoint_at FROM session_seq WHERE session_id = ?")
    .get(session_id);
  const lastCheckpoint = Number(row?.last_checkpoint_at ?? 0);

  if (lastCheckpoint > 0 && now - lastCheckpoint < CHECKPOINT_INTERVAL_MS) {
    return { fired: false, reason: "rate_limited" };
  }

  // Build minimal checkpoint payload
  const payload = {
    cwd,
    captured_at: now,
    interval_ms: lastCheckpoint > 0 ? now - lastCheckpoint : null,
    ...extra_payload,
  };

  await enqueueEvent({
    session_id,
    event_type: "checkpoint",
    source: source ?? "claude_code",
    project_id: project_id ?? null,
    user_id: user_id ?? null,
    payload,
  });

  // Update last_checkpoint_at (session_seq row was created when first
  // event was enqueued earlier in the same hook)
  db.prepare(
    "UPDATE session_seq SET last_checkpoint_at = ? WHERE session_id = ?",
  ).run(now, session_id);

  return { fired: true, reason: "ok" };
}
