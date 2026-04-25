#!/usr/bin/env node
/**
 * Sprintra SessionEnd hook — VP-1137 (Phase 5).
 *
 * Fires on hard session exit. Tells Sprintra "this session is over" so the
 * next session's briefing can show "Last session: <auto-summary>".
 *
 * Lightweight (2s budget, fire-and-forget). Does NOT aggregate observations
 * — that's Stop hook's job (which fires more frequently and runs first).
 *
 * Stdin: { sessionId, cwd, ... }
 * Endpoint: POST /api/projects/:pid/work-sessions/end-by-claude-session
 *   body: { claude_session_id, ended_at }
 */

import { readStdin, resolveContext, httpRequest, installHardTimeout, debug } from "./lib/hook-context.js";

const TIMEOUT_MS = 2000;
const HARD_KILL_MS = 2500;

export async function main() {
  const stdinData = (await readStdin()) || {};
  const cwd = stdinData.cwd || process.cwd();
  const sessionId = stdinData.sessionId || null;
  if (!sessionId) {
    debug("session-end", "no sessionId in stdin — silent exit");
    return;
  }

  const ctx = await resolveContext(cwd);
  if (!ctx) {
    debug("session-end", "no project resolved — silent exit");
    return;
  }

  const { project, apiUrl, token } = ctx;
  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/work-sessions/end-by-claude-session`;
  const headers = { "Content-Type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await httpRequest("POST", url, headers, {
    claude_session_id: sessionId,
    ended_at: Date.now(),
  }, TIMEOUT_MS);
  debug("session-end", `claude_session=${sessionId} status=${res?.status ?? "no-response"}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("session-end.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("session-end", "uncaught:", e.message))
    .finally(() => { cancelTimeout(); process.exit(0); });
}
