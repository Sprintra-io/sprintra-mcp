#!/usr/bin/env node
/**
 * Sprintra SessionStart hook — VP-1027 / VP-1309.
 *
 * Auto-injects a compact project briefing into the agent's context at session boot.
 * Replaces CLAUDE.md "Rule 1" (manual context loading) with zero-effort automatic injection.
 *
 * Lifecycle:
 *   1. Read JSON metadata from stdin (Claude Code passes session info)
 *   2. Resolve project from cwd (.sprintra/project.json walk-up → silent exit)
 *   3. Pick API base + auth via shared lib (env > stored config > local-if-up > prod)
 *   4. Fetch GET /api/projects/:pid/briefing → markdown (cloud project context)
 *   5. VP-1309 — local-first: read last-session digest from local buffer-sqlite;
 *      cloud digest is fallback only (new-machine case). Decision dec-VECWrRkd.
 *   6. VP-1309 — "Relevant past observations" section: embed (project, repo, last
 *      5 commit subjects) via cloud Gemini endpoint, brute-force cosine over local
 *      observation cache, surface top-3 hits. Capped at 500 tokens. Fully degrades
 *      to omitted-section if local cache is empty, embed endpoint unreachable, or
 *      cosine util unavailable. Decision dec-RQtOzDnr.
 *   7. Emit JSON envelope (hookSpecificOutput) so Claude Code injects + displays it
 *   8. ALWAYS exit 0 — never block the agent on Sprintra failure
 *
 * Brand rule (dec-8En6Ko3j): briefing markdown is user-facing in the terminal —
 * NEVER expose internal IDs (VP-####, dec-XXX), table names, or REST paths.
 *
 * Decision: dec-iXgsoPPa (proactive context), dec-r93TDhG4 (.sprintra marker),
 *           dec-VECWrRkd (local-first digest), dec-RQtOzDnr (Phase 7 observations)
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  readStdin, resolveContext, httpRequest, installHardTimeout, debug,
  isStrictLocalMemory,
  // re-exports for backward compat with existing test file:
  findProjectMarker as _findProjectMarker,
  resolveProject as _resolveProject,
  pickApiUrl as _pickApiUrl,
  readStoredConfig as _readStoredConfig,
  isLocalApiUp as _isLocalApiUp,
  CONFIG_FILE as _CONFIG_FILE,
  PROD_API as _PROD_API,
  LOCAL_API as _LOCAL_API,
} from "./lib/hook-context.js";

// Backward-compat re-exports — tests import these from session-start.js
export const findProjectMarker = _findProjectMarker;
export const resolveProject = _resolveProject;
export const pickApiUrl = _pickApiUrl;
export const readStoredConfig = _readStoredConfig;
export const isLocalApiUp = _isLocalApiUp;
export async function fetchBriefing(apiUrl, projectId, token) {
  // Backward-compat for existing tests — uses raw fetch so we can read the
  // x-sprintra-token-estimate response header (httpRequest hides response headers).
  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(projectId)}/briefing`;
  const headers = { accept: "text/markdown", connection: "close" };
  if (token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, keepalive: false });
    if (!res.ok) return null;
    const text = await res.text();
    const headerEst = res.headers.get("x-sprintra-token-estimate");
    const tokenEstimate = headerEst ? parseInt(headerEst, 10) : Math.ceil(text.length / 4);
    return { text, tokenEstimate };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const TIMEOUT_MS = 8000;
const HARD_KILL_MS = 11000; // VP-1232: leaves headroom for git sync (3s) + briefing (8s)
const GIT_SYNC_TIMEOUT_MS = 3000; // VP-1232: short timeout — never block briefing on sync

/**
 * VP-1232 — best-effort git sync before briefing fetch. Keeps git_commits table
 * fresh so the briefing's "Recent commits" section reflects today's work
 * instead of whatever was last synced (could be 50+ days stale).
 *
 * Silent on all failures: not a git repo, repo without origin, API down,
 * timeout, etc. Briefing always fetches even if sync fails.
 */
async function syncGitBeforeBriefing(apiUrl, projectId, token) {
  try {
    const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(projectId)}/git/sync`;
    const headers = { "Content-Type": "application/json", accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await httpRequest("POST", url, headers, "{}", GIT_SYNC_TIMEOUT_MS);
    if (res?.ok) {
      debug("session-start", `git sync ok: ${res.body?.slice(0, 80) || "no body"}`);
    } else {
      debug("session-start", `git sync http status: ${res?.status ?? "no-response"} — continuing`);
    }
  } catch (e) {
    debug("session-start", `git sync error: ${e.message} — continuing`);
  }
}

export function frameBriefing(briefing, source) {
  const lines = [];
  lines.push("# Sprintra Memory — Session Briefing");
  lines.push(`<!-- source: ${source} | injected at SessionStart -->`);
  lines.push("");
  lines.push(briefing.trim());
  lines.push("");
  lines.push("_(Auto-injected by Sprintra SessionStart hook. Use `mcp__vibepilot__ai generate_briefing` to refresh.)_");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// VP-1309 — Phase 7 helpers (local digest read, observations search)
// ────────────────────────────────────────────────────────────────────────────

const OBSERVATIONS_TIMEOUT_MS = 4000;
const OBSERVATIONS_TOKEN_BUDGET = 500;
const OBSERVATIONS_TOPK = 3;
const DIGEST_PREVIEW_CHARS = 150;
const RECENT_COMMITS_FOR_QUERY = 5;

/** Approximate token count from char count (~4 chars per token). */
function approxTokens(text) {
  return Math.ceil((text || "").length / 4);
}

/**
 * Run `git log --pretty=%s -n N` in repoPath. Returns array of subjects, or []
 * on any failure (not a repo, git missing, no commits, timeout, etc.).
 *
 * Pure JS using node:child_process — NO new npm deps.
 */
export function getRecentGitCommits(repoPath, limit = RECENT_COMMITS_FOR_QUERY, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!repoPath || typeof repoPath !== "string") return resolve([]);
    let stdout = "";
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(val);
    };
    let child;
    try {
      child = spawn("git", ["-C", repoPath, "log", "--pretty=%s", `-n${limit}`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve([]);
    }
    child.stdout.setEncoding("utf-8").on("data", (c) => (stdout += c));
    child.on("error", () => finish([]));
    child.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) return finish([]);
      const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, limit);
      finish(lines);
    });
    setTimeout(() => finish([]), timeoutMs);
  });
}

/**
 * Build the natural-language query used to seed the observations search.
 * Combines project name + repo path basename + recent commit subjects.
 *
 * Brand rule: this query goes to the embedding model only — not to the user
 * surface — so internal repo paths are fine.
 */
export function buildObservationsQuery(projectName, repoPath, commitSubjects) {
  const parts = [];
  if (projectName) parts.push(`project: ${projectName}`);
  if (repoPath) parts.push(`repo: ${repoPath}`);
  if (Array.isArray(commitSubjects) && commitSubjects.length) {
    parts.push(`recent work: ${commitSubjects.join("; ")}`);
  }
  return parts.join("\n");
}

/**
 * POST query to the cloud Gemini embedding endpoint. Returns a Buffer holding
 * a Float32 little-endian payload (the shape Agent A's cosine-search.js uses)
 * or null on any failure. Endpoint matches the one used by Agent A's
 * Phase 7 drain worker:
 *   POST {apiUrl}/api/embed   body: { text }
 *   → 200 with raw application/octet-stream Float32-LE bytes,
 *     OR 200 application/json with { embedding: number[] } (compat fallback).
 *
 * Uses raw fetch (NOT shared httpRequest) because httpRequest reads body via
 * res.text() which UTF-8-corrupts binary octet-stream payloads. Here we use
 * .arrayBuffer() to preserve bytes intact.
 *
 * Per dec-RQtOzDnr: reuse the cloud embedding service so the local plugin
 * doesn't need a Gemini API key. If the endpoint is unreachable or returns
 * a non-2xx, we degrade to omitting the section silently — this hook MUST
 * never fail.
 */
export async function embedQueryViaCloud(apiUrl, token, _projectIdUnused, query) {
  if (!apiUrl || !query) return null;
  const url = `${apiUrl.replace(/\/$/, "")}/api/embed`;
  const headers = {
    "Content-Type": "application/json",
    accept: "application/octet-stream, application/json",
    connection: "close",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OBSERVATIONS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: query }),
      signal: ctrl.signal,
      keepalive: false,
    });
    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      try {
        const parsed = await res.json();
        const vec = parsed?.embedding;
        if (Array.isArray(vec) && vec.length) return numbersToFloat32LEBuffer(vec);
      } catch {}
      return null;
    }
    // Treat anything else as raw Float32 LE bytes (Agent A's primary shape).
    const ab = await res.arrayBuffer();
    if (!ab || ab.byteLength === 0 || ab.byteLength % 4 !== 0) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lazy-import Agent A's cosine-search lib. Returns the named exports or null
 * if the module is unavailable (Agent A's file may not have landed yet, or
 * the plugin was installed without that file in older versions).
 *
 * Per the implementation plan, Agent A is creating
 * packages/plugin/scripts/lib/cosine-search.js with named exports
 * `cosineSimilarity` and `topKByCosine`.
 */
async function loadCosineSearch() {
  try {
    const mod = await import("./lib/cosine-search.js");
    if (typeof mod.cosineSimilarity !== "function") return null;
    if (typeof mod.topKByCosine !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Lazy-import the local SQLite buffer (Agent A's embedding-augmented schema).
 * Returns the openBuffer function or null if better-sqlite3 isn't available
 * (marketplace plugin contexts ship without node_modules).
 */
async function loadBuffer() {
  try {
    const mod = await import("./lib/buffer-sqlite.js");
    if (typeof mod.openBuffer !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Read the most recent local session digest for this project from Agent A's
 * `session_digests` table (VP-1306, dec-RQtOzDnr). Excludes private digests
 * (Agent A's listSessionDigests handles that automatically).
 *
 * Returns the parsed digest payload merged with row metadata, or null if:
 *   - better-sqlite3 unavailable
 *   - listSessionDigests helper not exported (older Agent A version)
 *   - no non-private digest rows for this project
 *
 * Decision: dec-VECWrRkd — local-first digest read.
 */
export async function readLocalDigest(projectId) {
  const buf = await loadBuffer();
  if (!buf) return null;
  if (typeof buf.listSessionDigests !== "function") return null;
  try {
    const list = await buf.listSessionDigests({ project_id: projectId });
    if (!Array.isArray(list) || !list.length) return null;
    // Pick the most recent — listSessionDigests doesn't promise order, so
    // sort by updated_at/created_at when present.
    const sorted = [...list].sort((a, b) => {
      const ka = a.updated_at ?? a.updatedAt ?? a.created_at ?? a.createdAt ?? 0;
      const kb = b.updated_at ?? b.updatedAt ?? b.created_at ?? b.createdAt ?? 0;
      return Number(kb) - Number(ka);
    });
    const row = sorted[0];
    let payload = null;
    if (row.payload_json) {
      try { payload = JSON.parse(row.payload_json); } catch {}
    } else if (row.payload) {
      payload = row.payload;
    }
    // Surface payload fields at the top-level so formatLocalDigestSection can
    // read them with its existing field-probing logic.
    return { ...row, ...(payload || {}) };
  } catch {
    return null;
  }
}

/**
 * Format a local digest row as a compact markdown section. Truncates each
 * preview to ~150 chars per item per the token budget. NEVER emits internal
 * IDs into the markdown (brand rule dec-8En6Ko3j).
 */
export function formatLocalDigestSection(row) {
  if (!row) return "";
  const what = row.what_was_discussed || row.whatWasDiscussed || "";
  const reasoning = row.reasoning_summary || row.reasoningSummary || "";
  const sentiment = row.sentiment || "";
  const pendingRaw = row.pending_asks_json || row.pendingAsksJson || row.pending_asks || row.pendingAsks;
  const pushbackRaw = row.user_pushback_json || row.userPushbackJson || row.user_pushback || row.userPushback;
  const frustrationRaw = row.frustration_signals_json || row.frustrationSignalsJson || row.frustration_signals;

  const safeParse = (v) => {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return null;
  };
  const clip = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, DIGEST_PREVIEW_CHARS) : "");

  const lines = [];
  lines.push("## Last working session (local)");
  if (sentiment) lines.push(`_Sentiment:_ ${clip(sentiment)}`);
  if (what) lines.push(`**What was discussed:** ${clip(what)}`);
  if (reasoning) lines.push(`**Reasoning:** ${clip(reasoning)}`);
  const pending = safeParse(pendingRaw);
  if (Array.isArray(pending) && pending.length) {
    lines.push("**Pending asks:**");
    for (const p of pending.slice(0, 3)) {
      const text = typeof p === "string" ? p : (p?.text || p?.title || JSON.stringify(p));
      lines.push(`- ${clip(text)}`);
    }
  }
  const pushback = safeParse(pushbackRaw);
  if (Array.isArray(pushback) && pushback.length) {
    lines.push("**User pushback last time:**");
    for (const p of pushback.slice(0, 3)) {
      const text = typeof p === "string" ? p : (p?.point || p?.text || JSON.stringify(p));
      lines.push(`- ${clip(text)}`);
    }
  }
  const frustration = safeParse(frustrationRaw);
  if (Array.isArray(frustration) && frustration.length) {
    lines.push("**Frustration signals:**");
    for (const f of frustration.slice(0, 2)) {
      lines.push(`- ${clip(typeof f === "string" ? f : JSON.stringify(f))}`);
    }
  }
  return lines.join("\n");
}

/**
 * Convert a number[] (e.g., from the cloud Gemini endpoint) into the same
 * BLOB format Agent A's cosine-search.js expects: a Buffer holding a Float32
 * little-endian payload.
 */
export function numbersToFloat32LEBuffer(vec) {
  if (!Array.isArray(vec) || !vec.length) return null;
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = Number(vec[i]) || 0;
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Build a short observation "content" string from a digest payload — used
 * both as the cosine candidate label and the rendered preview.
 */
function digestContent(row, payload) {
  const what = payload?.what_was_discussed || row?.what_was_discussed || row?.whatWasDiscussed || "";
  const reasoning = payload?.reasoning_summary || row?.reasoning_summary || row?.reasoningSummary || "";
  const pending = payload?.pending_asks || row?.pending_asks || row?.pendingAsks || [];
  const parts = [];
  if (what) parts.push(what);
  if (reasoning) parts.push(reasoning);
  if (Array.isArray(pending) && pending.length) {
    const heads = pending.slice(0, 2).map((p) => (typeof p === "string" ? p : (p?.text || p?.title || ""))).filter(Boolean);
    if (heads.length) parts.push("Pending: " + heads.join("; "));
  }
  return parts.join(" — ").slice(0, 600);
}

/**
 * Load local observations from Agent A's `session_digests` table for cosine
 * search. Excludes private rows (handled by listSessionDigests). Skips rows
 * that haven't been embedding-cached yet.
 *
 * Returns array of { id, content, embedding (Buffer), created_at }.
 * Empty array means "feature unavailable" — the caller omits the section.
 */
export async function loadLocalObservations(projectId) {
  const buf = await loadBuffer();
  if (!buf) return [];
  if (typeof buf.listSessionDigests !== "function") return [];
  let rows;
  try {
    rows = await buf.listSessionDigests({ project_id: projectId });
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || !rows.length) return [];

  const out = [];
  for (const r of rows) {
    if (!Buffer.isBuffer(r.embedding)) continue;
    if (r.embedding.byteLength === 0 || r.embedding.byteLength % 4 !== 0) continue;
    let payload = null;
    if (r.payload_json) {
      try { payload = JSON.parse(r.payload_json); } catch {}
    }
    const content = digestContent(r, payload);
    if (!content) continue;
    out.push({
      id: r.digest_id || r.id || null,
      content,
      embedding: r.embedding,
      created_at: r.created_at ?? r.createdAt ?? null,
    });
  }
  return out;
}

/**
 * Render the "Relevant past observations" markdown section. Caps total length
 * at OBSERVATIONS_TOKEN_BUDGET tokens (~2000 chars). Per-item preview is clipped
 * at DIGEST_PREVIEW_CHARS chars.
 *
 * Returns "" if hits is empty (caller skips the section).
 */
export function formatPastObservationsSection(hits) {
  if (!Array.isArray(hits) || !hits.length) return "";
  const lines = [];
  lines.push("## Relevant past observations");
  lines.push("_(matched by semantic similarity to your current project + recent commits)_");
  lines.push("");
  let used = approxTokens(lines.join("\n"));
  for (const h of hits) {
    const preview = (h.content || "").replace(/\s+/g, " ").trim().slice(0, DIGEST_PREVIEW_CHARS);
    if (!preview) continue;
    const score = typeof h.score === "number" ? ` _(${(h.score * 100).toFixed(0)}%)_` : "";
    const item = `- ${preview}${score}`;
    const cost = approxTokens(item) + 1;
    if (used + cost > OBSERVATIONS_TOKEN_BUDGET) break;
    lines.push(item);
    used += cost;
  }
  // Section is only meaningful if at least one bullet rendered
  return lines.length > 3 ? lines.join("\n") : "";
}

/**
 * Top-level orchestration for the new "Relevant past observations" section.
 * Wraps every step in graceful-degrade try/catches — this section MUST be
 * fully optional. Returns the markdown string or "" if any step fails.
 *
 * Steps (per dec-RQtOzDnr):
 *   1. Build query from project name + repo_path + last 5 commit subjects
 *   2. POST query to cloud embed endpoint → query vector
 *   3. Load local observation cache (rows w/ embedding + content)
 *   4. cosine-rank, take top-3, render compact markdown ≤500 tokens
 */
/**
 * VP-1311 follow-up — append-only local recall log.
 *
 * Records each SessionStart that injected observations into the briefing.
 * Lives at ~/.sprintra/recall-events.jsonl, one JSON line per event:
 *   { ts, project_id, hit_count, top_score, bottom_score }
 *
 * Local-only — never crosses the network, never costs anything. The user can
 * `tail ~/.sprintra/recall-events.jsonl` to verify recall is firing.
 *
 * Best-effort: silently swallows errors. Never propagates from a hook.
 */
export function recallLogPath() {
  const home = process.env.HOME || homedir();
  return join(home, ".sprintra", "recall-events.jsonl");
}

export async function logRecallEvent({ project_id, hit_count, top_score, bottom_score }) {
  try {
    const file = recallLogPath();
    await mkdir(dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      project_id,
      hit_count,
      top_score: Number(top_score?.toFixed(4) ?? 0),
      bottom_score: Number(bottom_score?.toFixed(4) ?? 0),
    }) + "\n";
    await appendFile(file, line, "utf8");
  } catch (_e) {
    // Best-effort — never fatal.
  }
}

export async function buildPastObservationsSection({ apiUrl, token, project, repoPath }) {
  try {
    const [cosine, observations, commits] = await Promise.all([
      loadCosineSearch(),
      loadLocalObservations(project.project_id),
      getRecentGitCommits(repoPath || project.repo_path || process.cwd(), RECENT_COMMITS_FOR_QUERY),
    ]);
    if (!cosine) {
      debug("session-start", "observations: cosine-search lib unavailable — omitting section");
      return "";
    }
    if (!observations.length) {
      debug("session-start", "observations: local cache empty — omitting section");
      return "";
    }
    const query = buildObservationsQuery(project.name || project.project_name, repoPath, commits);
    if (!query) return "";

    const queryBuf = await embedQueryViaCloud(apiUrl, token, project.project_id, query);
    if (!queryBuf) {
      debug("session-start", "observations: embed endpoint unreachable — omitting section");
      return "";
    }

    // topKByCosine returns [{ id, score }] only — map ids back to content.
    const ranked = cosine.topKByCosine(queryBuf, observations, OBSERVATIONS_TOPK);
    if (!ranked.length) return "";
    const byId = new Map(observations.map((o) => [o.id, o]));
    const hits = ranked
      .map((r) => {
        const obs = byId.get(r.id);
        if (!obs) return null;
        return { content: obs.content, score: r.score };
      })
      .filter((x) => x && x.score > 0);

    // VP-1311 follow-up — local recall-hit telemetry. Best-effort append to
    // ~/.sprintra/recall-events.jsonl (one line per SessionStart that injected
    // observations). Stays local — no cloud egress, no added cost, gives the
    // user a concrete log of "did the recall section actually retrieve anything"
    // they can `tail` to verify. Fully silent on any failure.
    if (hits.length > 0) {
      logRecallEvent({
        project_id: project.project_id,
        hit_count: hits.length,
        top_score: hits[0].score,
        bottom_score: hits[hits.length - 1].score,
      }).catch(() => {});
    }

    return formatPastObservationsSection(hits);
  } catch (e) {
    debug("session-start", `observations: error ${e?.message || e} — omitting section`);
    return "";
  }
}

export async function main() {
  await readStdin(); // drain even if we don't use it

  const cwd = process.cwd();
  const ctx = await resolveContext(cwd);
  if (!ctx) {
    debug("session-start", "no project resolved for cwd", cwd);
    return;
  }

  const { project, apiUrl, token, identity } = ctx;
  debug("session-start", `api=${apiUrl} token=${token ? "set" : "none"} project=${project.project_id} user=${identity.email || "anonymous"}`);

  // VP-1232: opt-out via stored config — most users want auto-sync
  const skipGitSync = ctx.stored?.skip_git_sync === true;
  if (!skipGitSync) {
    await syncGitBeforeBriefing(apiUrl, project.project_id, token);
  } else {
    debug("session-start", "git sync skipped via config (skip_git_sync=true)");
  }

  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/briefing`;
  const headers = { accept: "text/markdown" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await httpRequest("GET", url, headers, null, TIMEOUT_MS);
  if (!res || !res.ok || !res.body) {
    debug("session-start", `briefing http status: ${res?.status ?? "no-response"} — silent exit`);
    return;
  }

  let cloudBriefing = res.body;

  // VP-1309 — local-first digest. Read the most recent digest from the local
  // SQLite buffer (Agent A's schema additions). The cloud briefing already
  // includes a digest section; if local has fresher data we PREPEND a
  // "Last working session (local)" section so the agent sees both layers
  // without us needing to surgically edit cloud markdown.
  // Per dec-VECWrRkd: local first, cloud only as fallback for new-machine case.
  let localDigestSection = "";
  try {
    const local = await readLocalDigest(project.project_id);
    if (local) {
      localDigestSection = formatLocalDigestSection(local);
      debug("session-start", "local digest available — prepending to briefing");
    } else {
      debug("session-start", "no local digest — relying on cloud briefing fallback");
    }
  } catch (e) {
    debug("session-start", `local digest read error: ${e?.message || e} — using cloud only`);
  }

  // VP-1309 — Phase 7 "Relevant past observations" section. Decision dec-RQtOzDnr.
  // Strict-local-memory users disable cloud egress entirely (skip the embed
  // round-trip); their local cache is still cosine-searched if a query vector
  // is available, but without the cloud embed call we can't seed the query, so
  // the section is omitted in that mode.
  let pastObservationsSection = "";
  const strictLocal = await isStrictLocalMemory();
  if (!strictLocal) {
    pastObservationsSection = await buildPastObservationsSection({
      apiUrl,
      token,
      project,
      repoPath: project.repo_path || process.cwd(),
    });
  } else {
    debug("session-start", "strict_local_memory=true — skipping cloud embed for observations");
  }

  // Compose final briefing: cloud body + (optional) local digest + (optional) observations
  const composed = [cloudBriefing.trim()];
  if (localDigestSection) {
    composed.push("");
    composed.push(localDigestSection);
  }
  if (pastObservationsSection) {
    composed.push("");
    composed.push(pastObservationsSection);
  }
  const merged = composed.join("\n");

  const tokenEstimate = Math.ceil(merged.length / 4);
  const framed = frameBriefing(merged, project._source || "unknown");

  // Claude Code's SessionStart hook contract — JSON envelope:
  //   additionalContext: injected into agent context (invisible to user)
  //   systemMessage: shown in terminal alongside other hook outputs
  // Plain text gets dropped silently — only this envelope is recognized.
  const sysMsg = `[sprintra] ${project.project_id} briefing loaded ~${tokenEstimate}t`;
  const envelope = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: framed,
    },
    systemMessage: sysMsg,
  };
  process.stdout.write(JSON.stringify(envelope));
  debug("session-start", `emitted briefing (~${tokenEstimate}t)`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("session-start.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("session-start", "uncaught:", e.message))
    .finally(() => { cancelTimeout(); process.exit(0); });
}
