/**
 * Sprintra Memory Layer Phase 6 — Local SQLite buffer.
 *
 * Every hook (UserPromptSubmit, PostToolUse, Stop) writes one row here
 * BEFORE any network call. Drain worker async-flushes batches to
 * api.sprintra.io. Survives Wi-Fi flaps, deploys, plane mode, crashes.
 *
 * Story: VP-1296
 * Spec: doc-7N8zPoZC
 *
 * Schema, claim/release pattern, and idempotency keys per security audit
 * (ae3b13f1803fbde86) and multi-IDE compat agent (a22824b85efdfd93a).
 */

import { mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

// Computed lazily so tests can override $HOME between cases.
// Honor $HOME env first (test-overridable) then fall back to os.homedir().
function getHome() {
  return process.env.HOME || homedir();
}
export function sprintraDir() {
  return join(getHome(), ".sprintra");
}
export function bufferPath() {
  return join(sprintraDir(), "buffer.sqlite");
}
// Back-compat exports (deprecated — use the functions above)
export const SPRINTRA_DIR = sprintraDir();
export const BUFFER_PATH = bufferPath();

// Caps per security audit
export const SOFT_CAP_BYTES = 100 * 1024 * 1024; // 100 MB
export const HARD_CAP_BYTES = 250 * 1024 * 1024; // 250 MB
export const SOFT_CAP_ROWS = 500_000;

// Sync state enum
export const STATE_PENDING = "pending";
export const STATE_CLAIMED = "claimed";
export const STATE_SYNCED = "synced";
export const STATE_FAILED = "failed";

// Stale claim recovery window (ms)
export const STALE_CLAIM_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────────────
// Filesystem detection (NFS/SMB → fall back to journal_mode=DELETE)
// ────────────────────────────────────────────────────────────────────────────

function isNetworkFilesystem(path) {
  // Best-effort detection — full statvfs is platform-specific and not always
  // available in Node. We use heuristics: macOS /Volumes, common NFS prefixes,
  // and SMB mount paths. Conservative: when in doubt, return false (use WAL).
  if (platform() === "darwin" && path.startsWith("/Volumes/")) return true;
  if (path.startsWith("/mnt/") || path.startsWith("/media/")) return true;
  if (path.includes("/nfs/") || path.includes("/smb/")) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Schema (versioned migrations)
// ────────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'claude_code',
    payload_json TEXT NOT NULL,
    project_id TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT '${STATE_PENDING}',
    claimed_by INTEGER,
    claimed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE(session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_pending_state_created
    ON pending_events(state, created_at);

  CREATE INDEX IF NOT EXISTS idx_pending_session
    ON pending_events(session_id);

  CREATE TABLE IF NOT EXISTS session_seq (
    session_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hook_failures (
    id INTEGER PRIMARY KEY DEFAULT 1,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at INTEGER,
    last_warning_at INTEGER,
    dropped_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_capture_at INTEGER,
    last_drain_success_at INTEGER
  );

  INSERT OR IGNORE INTO hook_failures (id) VALUES (1);
  INSERT OR IGNORE INTO heartbeat (id) VALUES (1);
`;

// ────────────────────────────────────────────────────────────────────────────
// Open / init
// ────────────────────────────────────────────────────────────────────────────

let _db = null;

export async function openBuffer() {
  if (_db) return _db;

  // Ensure ~/.sprintra exists with 0700 mode (lazy-resolved for testability)
  const dir = sprintraDir();
  const path = bufferPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const useWal = !isNetworkFilesystem(path);

  const db = new Database(path);
  db.pragma(`journal_mode = ${useWal ? "WAL" : "DELETE"}`);
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Quick integrity check; rotate on corruption
  try {
    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") {
      // Caller should rotate the file. For now, throw and let caller handle.
      throw new Error(`Buffer integrity check failed: ${result}`);
    }
  } catch (e) {
    db.close();
    throw e;
  }

  // Apply schema (idempotent)
  db.exec(SCHEMA_V1);
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
    "version",
    String(SCHEMA_VERSION),
  );

  _db = db;
  return _db;
}

export function closeBuffer() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bytes / row counts (for cap enforcement)
// ────────────────────────────────────────────────────────────────────────────

export async function getBufferSize() {
  try {
    const s = await stat(bufferPath());
    return s.size;
  } catch {
    return 0;
  }
}

export function getRowCount(db) {
  const row = db.prepare("SELECT COUNT(*) as c FROM pending_events").get();
  return row?.c ?? 0;
}

export async function isAtHardCap(db) {
  const bytes = await getBufferSize();
  if (bytes >= HARD_CAP_BYTES) return true;
  const rows = getRowCount(db);
  if (rows >= SOFT_CAP_ROWS * 1.5) return true;
  return false;
}

export async function isAtSoftCap(db) {
  const bytes = await getBufferSize();
  if (bytes >= SOFT_CAP_BYTES) return true;
  const rows = getRowCount(db);
  if (rows >= SOFT_CAP_ROWS) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Enqueue (write path — hooks call this)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Append an event to the buffer. Returns {ok, event_id} or {ok:false, reason}.
 *
 * @param {object} input
 * @param {string} input.session_id - claude_session_id
 * @param {string} input.event_type - 'user_prompt' | 'tool_call' | 'checkpoint' | 'stop'
 * @param {object} input.payload - JSON-serializable
 * @param {string} [input.source='claude_code']
 * @param {string} [input.project_id]
 * @param {string} [input.user_id]
 */
export async function enqueueEvent(input) {
  const db = await openBuffer();

  // Hard cap check
  if (await isAtHardCap(db)) {
    incrementDroppedCount(db);
    return { ok: false, reason: "buffer_full_hard_cap" };
  }

  // Soft cap: drop oldest synced rows to make room
  if (await isAtSoftCap(db)) {
    db.prepare(`
      DELETE FROM pending_events
      WHERE event_id IN (
        SELECT event_id FROM pending_events
        WHERE state = '${STATE_SYNCED}'
        ORDER BY created_at ASC
        LIMIT 100
      )
    `).run();
  }

  const event_id = randomUUID();
  const now = Date.now();

  // Get next seq for this session (atomic upsert)
  const seqRow = db.transaction(() => {
    db.prepare(`
      INSERT INTO session_seq (session_id, last_seq, last_activity_at)
      VALUES (?, 1, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seq = last_seq + 1,
        last_activity_at = excluded.last_activity_at
    `).run(input.session_id, now);
    return db.prepare("SELECT last_seq FROM session_seq WHERE session_id = ?").get(input.session_id);
  })();

  const seq = seqRow.last_seq;

  // Insert the event row
  db.prepare(`
    INSERT INTO pending_events
      (event_id, session_id, seq, event_type, source, payload_json, project_id, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event_id,
    input.session_id,
    seq,
    input.event_type,
    input.source ?? "claude_code",
    JSON.stringify(input.payload),
    input.project_id ?? null,
    input.user_id ?? null,
    now,
  );

  // Update heartbeat
  db.prepare("UPDATE heartbeat SET last_capture_at = ? WHERE id = 1").run(now);

  return { ok: true, event_id, seq };
}

// ────────────────────────────────────────────────────────────────────────────
// Claim / Ack / Nack (drain worker calls these)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Claim up to N pending events for sync. Atomic.
 * Returns array of rows.
 */
export async function claimBatch(limit = 50) {
  const db = await openBuffer();
  const now = Date.now();
  const pid = process.pid;

  // Reclaim stale claims first
  db.prepare(`
    UPDATE pending_events
    SET state = '${STATE_PENDING}', claimed_by = NULL, claimed_at = NULL
    WHERE state = '${STATE_CLAIMED}' AND claimed_at < ?
  `).run(now - STALE_CLAIM_MS);

  // Atomic claim: select N pending + update to claimed in one transaction
  const claimedIds = db.transaction(() => {
    const candidates = db.prepare(`
      SELECT event_id FROM pending_events
      WHERE state = '${STATE_PENDING}'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit);

    if (candidates.length === 0) return [];

    const placeholders = candidates.map(() => "?").join(",");
    db.prepare(`
      UPDATE pending_events
      SET state = '${STATE_CLAIMED}', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
      WHERE event_id IN (${placeholders})
    `).run(pid, now, ...candidates.map((c) => c.event_id));

    return candidates.map((c) => c.event_id);
  })();

  if (claimedIds.length === 0) return [];

  const rows = db.prepare(`
    SELECT * FROM pending_events
    WHERE event_id IN (${claimedIds.map(() => "?").join(",")})
  `).all(...claimedIds);

  return rows;
}

/**
 * Mark events as successfully synced (deletes them after marker for safety).
 */
export async function ackBatch(eventIds) {
  if (!eventIds.length) return;
  const db = await openBuffer();
  const now = Date.now();

  db.transaction(() => {
    const placeholders = eventIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE pending_events
      SET state = '${STATE_SYNCED}'
      WHERE event_id IN (${placeholders})
    `).run(...eventIds);

    db.prepare("UPDATE heartbeat SET last_drain_success_at = ? WHERE id = 1").run(now);
  })();

  // Clean up old synced rows (keep for 1 hour for debugging, then delete)
  db.prepare(`
    DELETE FROM pending_events
    WHERE state = '${STATE_SYNCED}' AND created_at < ?
  `).run(now - 60 * 60 * 1000);
}

/**
 * Mark events as failed. After max attempts, move to dead-letter (state=failed).
 */
export async function nackBatch(eventIds, error, maxAttempts = 5) {
  if (!eventIds.length) return;
  const db = await openBuffer();

  db.transaction(() => {
    const placeholders = eventIds.map(() => "?").join(",");
    // First check attempts; rows past max → failed; others → back to pending
    db.prepare(`
      UPDATE pending_events
      SET
        state = CASE WHEN attempts >= ? THEN '${STATE_FAILED}' ELSE '${STATE_PENDING}' END,
        claimed_by = NULL,
        claimed_at = NULL,
        last_error = ?
      WHERE event_id IN (${placeholders})
    `).run(maxAttempts, String(error).slice(0, 500), ...eventIds);
  })();
}

// ────────────────────────────────────────────────────────────────────────────
// Failure counter (fail-loud — VP-1300)
// ────────────────────────────────────────────────────────────────────────────

function incrementDroppedCount(db) {
  db.prepare("UPDATE hook_failures SET dropped_count = dropped_count + 1 WHERE id = 1").run();
}

export async function recordFailure(reason = "unknown") {
  const db = await openBuffer();
  db.prepare(`
    UPDATE hook_failures
    SET consecutive_failures = consecutive_failures + 1, last_failure_at = ?
    WHERE id = 1
  `).run(Date.now());
  return db.prepare("SELECT consecutive_failures FROM hook_failures WHERE id = 1").get();
}

export async function recordSuccess() {
  const db = await openBuffer();
  db.prepare("UPDATE hook_failures SET consecutive_failures = 0 WHERE id = 1").run();
}

export async function getFailureStats() {
  const db = await openBuffer();
  return db.prepare("SELECT * FROM hook_failures WHERE id = 1").get();
}

// ────────────────────────────────────────────────────────────────────────────
// Stats (for dashboard / sprintra status)
// ────────────────────────────────────────────────────────────────────────────

export async function getBufferStats() {
  const db = await openBuffer();
  const counts = db.prepare(`
    SELECT state, COUNT(*) as c FROM pending_events GROUP BY state
  `).all();
  const heartbeat = db.prepare("SELECT * FROM heartbeat WHERE id = 1").get();
  const failures = db.prepare("SELECT * FROM hook_failures WHERE id = 1").get();
  const bytes = await getBufferSize();
  return {
    counts: Object.fromEntries(counts.map((r) => [r.state, r.c])),
    bytes,
    soft_cap_bytes: SOFT_CAP_BYTES,
    hard_cap_bytes: HARD_CAP_BYTES,
    last_capture_at: heartbeat?.last_capture_at ?? null,
    last_drain_success_at: heartbeat?.last_drain_success_at ?? null,
    consecutive_failures: failures?.consecutive_failures ?? 0,
    dropped_count: failures?.dropped_count ?? 0,
  };
}
