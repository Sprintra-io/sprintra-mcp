#!/usr/bin/env node
/**
 * Sprintra PostToolUse hook.
 *
 * Phase 6 (default OFF in v1.4.0, controlled by phase6_enabled flag):
 *   write redacted tool call to local SQLite buffer + drain async.
 *   Hot path: <2ms (one INSERT).
 *
 * Legacy (default ON until v1.5.0 flips the flag):
 *   POST directly to /api/projects/:pid/executions (the v1.3 path).
 *
 * Stdin (Claude Code hook contract):
 *   { sessionId, cwd, tool_name, tool_input, tool_response, ... }
 *
 * Story: VP-1299. Spec: doc-7N8zPoZC.
 */

import {
  readStdin,
  resolveContext,
  httpRequest,
  installHardTimeout,
  debug,
  isPhase6Enabled,
  detectIdeSource,
} from "./lib/hook-context.js";
import { redactToolCall } from "./lib/secrets-redactor.js";

// Phase 6 buffer/drain/checkpoint deps are loaded LAZILY because they require
// better-sqlite3 which isn't always available in marketplace plugin contexts
// (no node_modules bundled). On failure, hooks gracefully fall through to
// legacy HTTP-direct path.
let _phase6Modules = null;
async function loadPhase6() {
  if (_phase6Modules !== null) return _phase6Modules; // cached (could be false)
  try {
    const [buffer, drain, attach, checkpoint] = await Promise.all([
      import("./lib/buffer-sqlite.js"),
      import("./lib/drain-worker.js"),
      import("./lib/auto-attach.js"),
      import("./lib/checkpoint-worker.js"),
    ]);
    _phase6Modules = {
      enqueueEvent: buffer.enqueueEvent,
      drainBuffer: drain.drainBuffer,
      autoAttach: attach.autoAttach,
      UNATTACHED_PROJECT_ID: attach.UNATTACHED_PROJECT_ID,
      maybeFireCheckpoint: checkpoint.maybeFireCheckpoint,
    };
    return _phase6Modules;
  } catch (e) {
    debug("post-tool-use", `phase6 deps unavailable: ${e.message}`);
    _phase6Modules = false;
    return null;
  }
}

const TIMEOUT_MS = 5000;
const HARD_KILL_MS = 5500;

/** Legacy v1.3 path — direct HTTP POST. Kept for backward compat. */
async function legacyPath({ ctx, toolName, toolInput, toolResponse, sessionId, cwd }) {
  const { project, apiUrl, token, identity } = ctx;
  const metrics = { tool: toolName };
  if (toolInput?.file_path) metrics.file_path = String(toolInput.file_path).slice(0, 200);
  if (toolInput?.path) metrics.file_path = String(toolInput.path).slice(0, 200);
  if (toolInput?.command) metrics.command = String(toolInput.command).slice(0, 200);
  if (toolInput?.url) metrics.url = String(toolInput.url).slice(0, 200);
  if (toolInput?.pattern) metrics.pattern = String(toolInput.pattern).slice(0, 200);
  if (sessionId) metrics.session_id = sessionId;
  if (identity.user_id) metrics.user_id = identity.user_id;

  const exitStatus =
    toolResponse?.error || toolResponse?.is_error ? "error" : "success";
  const contentRef = String(
    metrics.file_path || metrics.command || metrics.url || metrics.pattern || toolName,
  ).slice(0, 200);

  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(
    project.project_id,
  )}/executions`;
  const headers = { "Content-Type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const body = {
    channel: "claude-code",
    action_type: `tool:${toolName}`,
    content_ref: contentRef,
    metrics_json: metrics,
    exit_status: exitStatus,
    occurred_at: Date.now(),
  };

  const res = await httpRequest("POST", url, headers, body, TIMEOUT_MS);
  debug("post-tool-use", `legacy tool=${toolName} status=${res?.status ?? "no-response"}`);
}

/** Phase 6 path — write to local buffer + drain async.
 * Returns true if path completed successfully, false if Phase 6 deps unavailable
 * (caller falls through to legacy path). */
async function phase6Path({ ctx, toolName, toolInput, toolResponse, sessionId, cwd }) {
  const phase6 = await loadPhase6();
  if (!phase6) return false;
  const { enqueueEvent, drainBuffer, autoAttach, UNATTACHED_PROJECT_ID, maybeFireCheckpoint } = phase6;

  // Resolve project (auto-attach if missing)
  let projectId = ctx?.project?.project_id;
  if (!projectId) {
    const attached = await autoAttach({
      cwd,
      apiUrl: ctx?.apiUrl ?? null,
      token: ctx?.token ?? null,
    });
    projectId = attached.project_id;
  }

  // Redact secrets BEFORE writing to buffer (never lands on disk)
  const redacted = redactToolCall({
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolResponse,
    captureFullPayloads: process.env.SPRINTRA_FULL_TOOL_PAYLOADS === "true",
  });

  await enqueueEvent({
    session_id: sessionId || "unknown-session",
    event_type: "tool_call",
    source: detectIdeSource(),
    project_id: projectId !== UNATTACHED_PROJECT_ID ? projectId : null,
    user_id: ctx?.identity?.user_id ?? null,
    payload: {
      tool_name: toolName,
      cwd,
      ...redacted.summary,
      occurred_at: Date.now(),
    },
  });

  // VP-1294: opportunistic checkpoint (≥60s since last)
  await maybeFireCheckpoint({
    session_id: sessionId || "unknown-session",
    source: detectIdeSource(),
    project_id: projectId !== UNATTACHED_PROJECT_ID ? projectId : null,
    user_id: ctx?.identity?.user_id ?? null,
    cwd,
    extra_payload: { last_tool: toolName },
  }).catch(() => {});

  // Async drain (best effort — don't block hook)
  if (ctx?.apiUrl && ctx?.token) {
    drainBuffer({ apiUrl: ctx.apiUrl, token: ctx.token, maxBatches: 2 })
      .then((r) => debug("post-tool-use", `drained ${r.accepted}/${r.drained}`))
      .catch(() => {});
  }
  return true;
}

export async function main() {
  const stdinData = (await readStdin()) || {};
  const cwd = stdinData.cwd || process.cwd();
  const toolName = stdinData.tool_name || "unknown";
  const toolInput = stdinData.tool_input || null;
  const toolResponse = stdinData.tool_response || null;
  const sessionId = stdinData.sessionId || null;

  // Skip Sprintra MCP self-calls to avoid recursion / noise.
  if (toolName.startsWith("mcp__vibepilot__") || toolName.startsWith("mcp__sprintra")) {
    debug("post-tool-use", `skipping self-call ${toolName}`);
    return;
  }

  // Detect Claude Desktop — Phase 6 explicitly disabled there
  if (detectIdeSource() === "claude_desktop_disabled") {
    debug("post-tool-use", "claude_desktop disabled — silent exit");
    return;
  }

  const ctx = await resolveContext(cwd);
  const phase6 = await isPhase6Enabled();

  if (phase6) {
    // Phase 6: buffer-write path (works even if ctx is null via auto-attach).
    // If Phase 6 deps (better-sqlite3) are unavailable in this environment,
    // phase6Path returns false and we fall through to legacy.
    try {
      const ok = await phase6Path({ ctx, toolName, toolInput, toolResponse, sessionId, cwd });
      if (ok) return;
      debug("post-tool-use", "phase6 deps unavailable — falling through to legacy");
    } catch (e) {
      debug("post-tool-use", `phase6 path error: ${e.message} — falling through to legacy`);
    }
  }

  // Legacy path requires resolved context
  if (!ctx) {
    debug("post-tool-use", "no project resolved — silent exit (legacy path)");
    return;
  }

  await legacyPath({ ctx, toolName, toolInput, toolResponse, sessionId, cwd });
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("post-tool-use.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("post-tool-use", "uncaught:", e.message))
    .finally(() => {
      cancelTimeout();
      process.exit(0);
    });
}
