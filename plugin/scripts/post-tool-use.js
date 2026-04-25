#!/usr/bin/env node
/**
 * Sprintra PostToolUse hook — VP-1135 (Phase 5).
 *
 * Fires after every Claude Code tool call (Read, Edit, Write, Bash, MCP, ...).
 * Captures the action into Sprintra's agent_actions table with project_id +
 * user_id attribution. Same pattern as claude-mem's worker-service observation
 * handler, but lightweight (no AI processing — just structured logging).
 *
 * Stdin (Claude Code hook contract):
 *   { sessionId, cwd, tool_name, tool_input, tool_response, ... }
 *
 * Endpoint: POST /api/projects/:pid/executions
 *   channel: "claude-code"
 *   action_type: `tool:<TOOL_NAME>`  (e.g. tool:Edit, tool:Bash, tool:mcp__vibepilot__stories)
 *   metrics_json: { tool, file_path?, command?, duration_ms?, prompt_number? }
 *   exit_status: "success" | "error"
 *   content_ref: short summary (file path or command name)
 *
 * NEVER blocks the agent: 5s hard timeout, silent exit on any failure,
 * fire-and-forget POST. If Sprintra is down, Claude Code never knows.
 */

import {
  readStdin, resolveContext, httpRequest, installHardTimeout, debug,
} from "./lib/hook-context.js";

const TIMEOUT_MS = 5000;
const HARD_KILL_MS = 5500;

/** Extract content_ref + metrics from tool_input (varies by tool). */
function extractContentRef(toolName, toolInput) {
  if (!toolInput) return { content_ref: toolName, metrics: { tool: toolName } };
  const metrics = { tool: toolName };

  // Common shapes
  if (toolInput.file_path) metrics.file_path = String(toolInput.file_path).slice(0, 200);
  if (toolInput.path) metrics.file_path = String(toolInput.path).slice(0, 200);
  if (toolInput.command) metrics.command = String(toolInput.command).slice(0, 200);
  if (toolInput.url) metrics.url = String(toolInput.url).slice(0, 200);
  if (toolInput.pattern) metrics.pattern = String(toolInput.pattern).slice(0, 200);
  if (typeof toolInput.offset === "number") metrics.offset = toolInput.offset;
  if (typeof toolInput.limit === "number") metrics.limit = toolInput.limit;

  // Build a 1-line content_ref
  const ref = metrics.file_path || metrics.command || metrics.url || metrics.pattern || toolName;
  return { content_ref: String(ref).slice(0, 200), metrics };
}

/** Determine exit_status from tool_response shape. */
function deriveExitStatus(toolResponse) {
  if (!toolResponse) return "success";
  if (typeof toolResponse === "object" && toolResponse !== null) {
    if (toolResponse.error || toolResponse.is_error) return "error";
  }
  return "success";
}

export async function main() {
  const stdinData = (await readStdin()) || {};
  const cwd = stdinData.cwd || process.cwd();
  const toolName = stdinData.tool_name || "unknown";
  const toolInput = stdinData.tool_input || null;
  const toolResponse = stdinData.tool_response || null;
  const sessionId = stdinData.sessionId || null;

  // Skip Sprintra MCP self-calls to avoid recursion / noise. We're already
  // capturing those via the executions MCP tool when an agent explicitly logs.
  if (toolName.startsWith("mcp__vibepilot__") || toolName.startsWith("mcp__sprintra")) {
    debug("post-tool-use", `skipping self-call ${toolName}`);
    return;
  }

  const ctx = await resolveContext(cwd);
  if (!ctx) {
    debug("post-tool-use", "no project resolved — silent exit");
    return;
  }

  const { project, apiUrl, token, identity } = ctx;
  const { content_ref, metrics } = extractContentRef(toolName, toolInput);
  const exit_status = deriveExitStatus(toolResponse);
  if (sessionId) metrics.session_id = sessionId;
  if (identity.user_id) metrics.user_id = identity.user_id;

  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/executions`;
  const headers = { "Content-Type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const body = {
    channel: "claude-code",
    action_type: `tool:${toolName}`,
    content_ref,
    metrics_json: metrics,
    exit_status,
    occurred_at: Date.now(),
  };

  const res = await httpRequest("POST", url, headers, body, TIMEOUT_MS);
  debug("post-tool-use", `tool=${toolName} status=${res?.status ?? "no-response"} cwd=${cwd}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("post-tool-use.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("post-tool-use", "uncaught:", e.message))
    .finally(() => { cancelTimeout(); process.exit(0); });
}
