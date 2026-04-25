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
 *   3. Pick API base + auth via shared lib (env > stored config > local-if-up > prod)
 *   4. Fetch GET /api/projects/:pid/briefing → markdown
 *   5. Emit JSON envelope (hookSpecificOutput) so Claude Code injects + displays it
 *   6. ALWAYS exit 0 — never block the agent on Sprintra failure
 *
 * Decision: dec-iXgsoPPa (proactive context), dec-r93TDhG4 (.sprintra marker)
 */

import {
  readStdin, resolveContext, httpRequest, installHardTimeout, debug,
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
const HARD_KILL_MS = 9000;

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
  const ctx = await resolveContext(cwd);
  if (!ctx) {
    debug("session-start", "no project resolved for cwd", cwd);
    return;
  }

  const { project, apiUrl, token, identity } = ctx;
  debug("session-start", `api=${apiUrl} token=${token ? "set" : "none"} project=${project.project_id} user=${identity.email || "anonymous"}`);

  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/briefing`;
  const headers = { accept: "text/markdown" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await httpRequest("GET", url, headers, null, TIMEOUT_MS);
  if (!res || !res.ok || !res.body) {
    debug("session-start", `briefing http status: ${res?.status ?? "no-response"} — silent exit`);
    return;
  }

  const text = res.body;
  const tokenEstimate = Math.ceil(text.length / 4);
  const framed = frameBriefing(text, project._source || "unknown");

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
