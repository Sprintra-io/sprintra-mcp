#!/usr/bin/env node
/**
 * Sprintra SessionStart hook — VP-1027.
 *
 * Auto-injects a compact project briefing into the agent's context at session boot.
 * Replaces CLAUDE.md "Rule 1" (manual context loading) with zero-effort automatic injection.
 *
 * Lifecycle:
 *   1. Read JSON metadata from stdin (Claude Code passes session info)
 *   2. Resolve project from cwd (.sprintra/project.json walk-up → silent exit)
 *   3. Pick API base: explicit env > stored config > local-if-up > prod default
 *   4. Pick auth: env > ~/.sprintra/config.json (written by `sprintra login`)
 *   5. Fetch GET /api/projects/:pid/briefing → markdown
 *   6. Print markdown to stdout (Claude Code injects into conversation)
 *   7. ALWAYS exit 0 — never block the agent on Sprintra failure
 *
 * Env vars (all optional):
 *   SPRINTRA_API_URL     — Base URL (overrides smart detection)
 *   SPRINTRA_TOKEN       — Bearer token (overrides stored config)
 *   SPRINTRA_PROJECT_ID  — Override project resolution (skip cwd detection)
 *   SPRINTRA_DEBUG       — Print debug info to stderr
 *
 * Decision: dec-iXgsoPPa (proactive context), dec-r93TDhG4 (.sprintra marker)
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const LOCAL_API = "http://127.0.0.1:4000";
const PROD_API = "https://api.sprintra.io";
const TIMEOUT_MS = 8000;
const HEALTH_PROBE_MS = 400;
const CONFIG_FILE = join(homedir(), ".sprintra", "config.json");
const debug = (...args) => {
  if (process.env.SPRINTRA_DEBUG) console.error("[sprintra-session-start]", ...args);
};

// Read JSON from stdin (Claude Code metadata) — bounded by 500ms failsafe
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    let timer;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      const raw = data.trim();
      if (!raw) return finish(null);
      try {
        finish(JSON.parse(raw));
      } catch (e) {
        debug("stdin parse failed:", e.message);
        finish(null);
      }
    });
    process.stdin.on("error", () => finish(null));
    timer = setTimeout(() => finish(null), 500);
  });
}

// Walk up from cwd looking for `.sprintra/project.json`
export async function findProjectMarker(startDir) {
  let dir = resolve(startDir);
  let depth = 0;
  while (depth < 20) {
    const markerPath = join(dir, ".sprintra", "project.json");
    try {
      const s = await stat(markerPath);
      if (s.isFile()) {
        const raw = await readFile(markerPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.project_id) return { ...parsed, _marker_path: markerPath };
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth += 1;
  }
  return null;
}

// Fetch with timeout — never throw, return null on any failure
export async function fetchBriefing(apiUrl, projectId, token) {
  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(projectId)}/briefing`;
  const headers = { accept: "text/markdown", connection: "close" };
  if (token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, keepalive: false });
    if (!res.ok) {
      debug("briefing http status:", res.status);
      return null;
    }
    const text = await res.text();
    const tokenEstimate = res.headers.get("x-sprintra-token-estimate");
    return { text, tokenEstimate: tokenEstimate ? parseInt(tokenEstimate, 10) : null };
  } catch (e) {
    debug("fetch failed:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve project: env override > marker file > null (silent exit)
export async function resolveProject(cwd) {
  if (process.env.SPRINTRA_PROJECT_ID) {
    return { project_id: process.env.SPRINTRA_PROJECT_ID, _source: "env" };
  }
  const marker = await findProjectMarker(cwd);
  if (marker) {
    return { ...marker, _source: "marker" };
  }
  return null;
}

// Read stored config (~/.sprintra/config.json) — written by `sprintra login`.
// Returns {} on any failure.
async function readStoredConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

// Probe local API quickly. Returns true iff /api/health responds in <400ms.
async function isLocalApiUp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_MS);
  try {
    const res = await fetch(`${LOCAL_API}/api/health`, { signal: ctrl.signal, keepalive: false });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Pick the right API URL — explicit env beats stored config beats live probe.
async function pickApiUrl(stored) {
  if (process.env.SPRINTRA_API_URL) return process.env.SPRINTRA_API_URL;
  if (stored.url) return stored.url;
  if (await isLocalApiUp()) return LOCAL_API;
  return PROD_API;
}

// Format briefing for stdout — wrap with light markdown frame
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

export async function main() {
  await readStdin(); // drain even if we don't use it

  const cwd = process.cwd();
  const project = await resolveProject(cwd);
  if (!project) {
    debug("no project resolved for cwd", cwd);
    return; // silent exit — no marker, no env, do nothing
  }

  const stored = await readStoredConfig();
  const apiUrl = await pickApiUrl(stored);
  const token = process.env.SPRINTRA_TOKEN || stored.token || null;
  debug(`api=${apiUrl} token=${token ? "set" : "none"} project=${project.project_id}`);

  const result = await fetchBriefing(apiUrl, project.project_id, token);
  if (!result || !result.text) {
    debug("no briefing fetched — silent exit");
    return; // silent — never block agent
  }

  const framed = frameBriefing(result.text, project._source || "unknown");
  // Claude Code's SessionStart hook contract:
  //   - additionalContext: injected into the agent's context (invisible to user)
  //   - systemMessage: shown in the terminal alongside other hook outputs
  // Emitting plain text only goes to stderr-style log lines and gets dropped.
  // claude-mem uses this same envelope — match its format so we render alongside it.
  const tokens = result.tokenEstimate ? `~${result.tokenEstimate}t` : "";
  const sysMsg = `[sprintra] ${project.project_id} briefing loaded ${tokens}`.trim();
  const envelope = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: framed,
    },
    systemMessage: sysMsg,
  };
  process.stdout.write(JSON.stringify(envelope));
  debug(`emitted briefing (${tokens || "tokens unknown"})`);
}

// Only run main if invoked directly (not when imported by tests)
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("session-start.js");
if (isMain) {
  // Hard wallclock cap — never block agent for more than 9s under any circumstances
  const hardKill = setTimeout(() => {
    debug("hard kill at 9s");
    process.exit(0);
  }, 9000);
  hardKill.unref();
  main()
    .catch((e) => debug("uncaught:", e.message))
    .finally(() => {
      clearTimeout(hardKill);
      process.exit(0);
    });
}
