#!/usr/bin/env node
/**
 * Sprintra Stop hook — VP-1136 (Phase 5).
 *
 * Fires when Claude Code session pauses (Ctrl+C, /clear, compaction).
 * Asks the API to summarize the session: aggregate the agent_actions
 * captured by post-tool-use.js during this Claude session window into
 * a single human-readable note.
 *
 * Lightweight (5s budget). Server does the heavy lifting via:
 *   POST /api/projects/:pid/sessions/summarize
 *   body: { claude_session_id, cwd }
 * The server queries agent_actions where session_id matches in metrics_json,
 * builds "Session 2026-04-25 — N tool calls, M files, X stories", inserts a note.
 *
 * The next SessionStart will pick up this note as part of the briefing's
 * "Last session" or "Recent notes" section.
 */

import { readStdin, resolveContext, httpRequest, installHardTimeout, debug } from "./lib/hook-context.js";

const TIMEOUT_MS = 5000;
const HARD_KILL_MS = 5500;

export async function main() {
  const stdinData = (await readStdin()) || {};
  const cwd = stdinData.cwd || process.cwd();
  const sessionId = stdinData.sessionId || null;
  if (!sessionId) {
    debug("stop", "no sessionId — silent exit");
    return;
  }

  const ctx = await resolveContext(cwd);
  if (!ctx) {
    debug("stop", "no project resolved — silent exit");
    return;
  }

  const { project, apiUrl, token } = ctx;
  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/sessions/summarize`;
  const headers = { "Content-Type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await httpRequest("POST", url, headers, {
    claude_session_id: sessionId,
    cwd,
    stopped_at: Date.now(),
  }, TIMEOUT_MS);
  debug("stop", `claude_session=${sessionId} status=${res?.status ?? "no-response"}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("stop.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("stop", "uncaught:", e.message))
    .finally(() => { cancelTimeout(); process.exit(0); });
}
