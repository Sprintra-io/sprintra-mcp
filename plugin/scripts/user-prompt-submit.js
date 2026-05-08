#!/usr/bin/env node
/**
 * Sprintra UserPromptSubmit hook — VP-1186.
 *
 * Fires every time the user submits a prompt to Claude Code. Captures the
 * verbatim user message into Sprintra's user_prompts table with project_id +
 * user_id attribution. Closes the claude-mem parity gap on the user-input side
 * (PostToolUse already captures agent actions).
 *
 * Stdin (Claude Code hook contract):
 *   { sessionId, cwd, prompt, hookEventName: "UserPromptSubmit", ... }
 *
 * Endpoint: POST /api/projects/:pid/user-prompts
 *   { claude_session_id, prompt, cwd?, work_session_id? }
 *
 * NEVER blocks the user: 5s hard timeout, silent exit on any failure,
 * fire-and-forget POST. If Sprintra is down, Claude Code never knows.
 *
 * Privacy: per-user via vpUserId resolution from token. A user retrieves only
 * their own prompts unless they have admin role.
 *
 * Opt-out: ~/.sprintra/config.json:capture_user_prompts=false bails before POST.
 */

import {
  readStdin, resolveContext, httpRequest, installHardTimeout, debug,
  isPhase6Enabled, isStrictLocalMemory, detectIdeSource,
} from "./lib/hook-context.js";
import { redactUserPrompt } from "./lib/secrets-redactor.js";

/**
 * VP-1310 — privacy gesture: `<private>` prefix.
 *
 * If the user's message begins with `<private>` (case-insensitive, leading
 * whitespace tolerated), the prompt is NOT captured anywhere — no buffer-sqlite
 * write, no cloud post, no embedding mark. The tag is stripped from the prompt
 * before Claude sees it so the agent sees only the real instruction.
 *
 * This is a per-prompt opt-out. For permanent opt-out use
 * config.capture_user_prompts=false. For permanent local-only use
 * config.strict_local_memory=true (VP-1310 server-side gate).
 */
const PRIVATE_TAG_RE = /^\s*<private>\s*/i;

export function isPrivatePrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return false;
  return PRIVATE_TAG_RE.test(prompt);
}

export function stripPrivateTag(prompt) {
  if (!prompt || typeof prompt !== "string") return prompt;
  return prompt.replace(PRIVATE_TAG_RE, "");
}

// Phase 6 deps are loaded lazily — better-sqlite3 may not be available in
// marketplace plugin contexts (no node_modules bundled). Hooks gracefully
// fall through to legacy HTTP-direct path when deps unavailable.
let _phase6Modules = null;
async function loadPhase6() {
  if (_phase6Modules !== null) return _phase6Modules;
  try {
    const [buffer, drain, attach] = await Promise.all([
      import("./lib/buffer-sqlite.js"),
      import("./lib/drain-worker.js"),
      import("./lib/auto-attach.js"),
    ]);
    _phase6Modules = {
      enqueueEvent: buffer.enqueueEvent,
      drainBuffer: drain.drainBuffer,
      autoAttach: attach.autoAttach,
      UNATTACHED_PROJECT_ID: attach.UNATTACHED_PROJECT_ID,
    };
    return _phase6Modules;
  } catch (e) {
    debug("user-prompt-submit", `phase6 deps unavailable: ${e.message}`);
    _phase6Modules = false;
    return null;
  }
}

const TIMEOUT_MS = 5000;
const HARD_KILL_MS = 5500;

/**
 * VP-1233: returns true if the prompt is a system-injected event (NOT a real
 * user message). Currently filters:
 *   - <task-notification>...</task-notification>  (Monitor / background task events)
 *   - <system-reminder>...</system-reminder>      (system-injected reminders)
 *
 * Filter is conservative: only matches when the prompt is ENTIRELY system-wrapped.
 * Mixed prompts (system event + real user text) are still captured.
 *
 * Slash commands (<command-name>...</command-name>) are KEPT — intentional user actions.
 */
export function isSystemEventPrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  // One or more system-event tags back-to-back with NOTHING else mixed in
  if (/^(<task-notification>[\s\S]*?<\/task-notification>\s*)+$/.test(trimmed)) return true;
  if (/^(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/.test(trimmed)) return true;
  // Mixed system-event blocks (task-notification AND system-reminder back-to-back)
  if (/^(<(task-notification|system-reminder)>[\s\S]*?<\/(task-notification|system-reminder)>\s*)+$/.test(trimmed)) return true;
  return false;
}

export async function main() {
  const stdinData = (await readStdin()) || {};
  const cwd = stdinData.cwd || process.cwd();
  const prompt = stdinData.prompt;
  const sessionId = stdinData.sessionId || stdinData.session_id || null;

  // Empty prompt? Nothing to capture.
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    debug("user-prompt-submit", "no prompt text — silent exit");
    return;
  }

  // VP-1310 — privacy gesture: prompt prefixed with `<private>` is NEVER captured.
  // Claude Code's UserPromptSubmit hook contract has no field to rewrite the
  // prompt itself, so we emit additionalContext telling the agent to treat the
  // leading <private> marker as metadata and respond to the substance after it.
  // The capture path is fully short-circuited (no buffer write, no cloud post,
  // no embedding mark), even when capture_user_prompts=true and Phase 6 is on.
  if (isPrivatePrompt(prompt)) {
    const stripped = stripPrivateTag(prompt);
    debug("user-prompt-submit", "private prompt — skipping capture");
    const envelope = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "[sprintra-privacy] The user's message starts with a `<private>` privacy marker. " +
          "That marker is a metadata gesture — it tells Sprintra not to capture the prompt to memory. " +
          "Respond to the user's actual request, which is the text AFTER the `<private>` tag:\n\n" +
          stripped,
      },
    };
    process.stdout.write(JSON.stringify(envelope));
    return;
  }

  // VP-1233: filter system-injected events (task-notifications, system-reminders).
  // Without this, "Recent asks" in the briefing gets polluted with monitor noise.
  if (isSystemEventPrompt(prompt)) {
    debug("user-prompt-submit", "system-event prompt — skipping capture");
    return;
  }

  // Detect Claude Desktop — Phase 6 explicitly disabled there
  if (detectIdeSource() === "claude_desktop_disabled") {
    debug("user-prompt-submit", "claude_desktop disabled — silent exit");
    return;
  }

  const ctx = await resolveContext(cwd);
  const phase6 = await isPhase6Enabled();

  // Honor user opt-out (works for both paths)
  if (ctx?.stored && ctx.stored.capture_user_prompts === false) {
    debug("user-prompt-submit", "capture disabled via config — silent exit");
    return;
  }

  if (phase6) {
    // Phase 6: redact + buffer + drain. If deps unavailable (better-sqlite3
    // missing in marketplace context), gracefully fall through to legacy.
    const p6 = await loadPhase6();
    if (p6) {
      try {
        const { enqueueEvent, drainBuffer, autoAttach, UNATTACHED_PROJECT_ID } = p6;
        let projectId = ctx?.project?.project_id;
        if (!projectId) {
          const attached = await autoAttach({
            cwd,
            apiUrl: ctx?.apiUrl ?? null,
            token: ctx?.token ?? null,
          });
          projectId = attached.project_id;
        }
        const { prompt: safePrompt, redactedCount } = redactUserPrompt(prompt);
        await enqueueEvent({
          session_id: sessionId || `unknown-${Date.now()}`,
          event_type: "user_prompt",
          source: detectIdeSource(),
          project_id: projectId !== UNATTACHED_PROJECT_ID ? projectId : null,
          user_id: ctx?.identity?.user_id ?? null,
          payload: {
            prompt: safePrompt,
            cwd,
            redaction_count: redactedCount,
            captured_at: Date.now(),
          },
        });
        // AWAIT drain (not fire-and-forget) — Node exits before async drain
        // completes, otherwise. Cap at 1 batch + 3s race-timeout so hook
        // always returns within budget. Older events catch up next hook fire.
        if (ctx?.apiUrl && ctx?.token) {
          try {
            const result = await Promise.race([
              drainBuffer({ apiUrl: ctx.apiUrl, token: ctx.token, maxBatches: 1 }),
              new Promise((resolve) =>
                setTimeout(() => resolve({ drained: 0, accepted: 0, rejected: 0, halted_reason: "hook_timeout" }), 3000),
              ),
            ]);
            debug("user-prompt-submit", `drained ${result.accepted}/${result.drained}${result.halted_reason ? ` (${result.halted_reason})` : ""}`);
          } catch (e) {
            debug("user-prompt-submit", `drain error: ${e.message}`);
          }
        }
        return;
      } catch (e) {
        debug("user-prompt-submit", `phase6 path error: ${e.message} — falling through to legacy`);
      }
    } else {
      debug("user-prompt-submit", "phase6 deps unavailable — falling through to legacy");
    }
  }

  // Legacy path requires resolved context
  if (!ctx) {
    debug("user-prompt-submit", "no project resolved — silent exit (legacy path)");
    return;
  }

  // Memory-layer cloud egress gate (dec-RQtOzDnr). Phase 6 path is gated via
  // drainBuffer; this legacy fallback POSTs directly to /user-prompts and must
  // also respect strict_local_memory. PM cloud sync is unaffected.
  if (await isStrictLocalMemory()) {
    debug("user-prompt-submit", "strict_local_memory — skipping legacy user-prompts POST");
    return;
  }

  const { project, apiUrl, token } = ctx;
  const url = `${apiUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(project.project_id)}/user-prompts`;
  const headers = { "Content-Type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const body = {
    claude_session_id: sessionId || `unknown-${Date.now()}`,
    prompt,
    cwd,
  };

  const res = await httpRequest("POST", url, headers, body, TIMEOUT_MS);
  debug("user-prompt-submit", `legacy status=${res?.status ?? "no-response"} cwd=${cwd} promptLen=${prompt.length}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("user-prompt-submit.js");
if (isMain) {
  const cancelTimeout = installHardTimeout(HARD_KILL_MS);
  main()
    .catch((e) => debug("user-prompt-submit", "uncaught:", e.message))
    .finally(() => { cancelTimeout(); process.exit(0); });
}
