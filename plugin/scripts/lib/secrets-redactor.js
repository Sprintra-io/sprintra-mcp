/**
 * Sprintra Memory Layer Phase 6 — Secrets redactor.
 *
 * Story: VP-1302. Spec: doc-7N8zPoZC §"From Security audit".
 *
 * Tool-specific redaction (Bash, Read, Edit, Write, Grep, Glob, WebFetch,
 * WebSearch) + generic OWASP regex pass on whatever content remains.
 *
 * Runs BEFORE writing to the buffer — secret never lands on disk.
 */

import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────
// Regex catalog (OWASP secret-scanner ruleset)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pattern → label mapping. Order matters — more specific patterns first.
 * Each pattern is tested with `g` flag and replaced with [redacted-{label}-{sha8}].
 */
const SECRET_PATTERNS = [
  // Anthropic must come BEFORE OpenAI — sk-ant-* would otherwise match generic sk- pattern
  { label: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "openai-key", regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { label: "github-pat", regex: /ghp_[A-Za-z0-9]{36}/g },
  { label: "github-oauth", regex: /gho_[A-Za-z0-9]{36}/g },
  { label: "github-app", regex: /(ghu|ghs)_[A-Za-z0-9]{36}/g },
  { label: "slack-token", regex: /xox[bpsoa]-[A-Za-z0-9-]+/g },
  { label: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { label: "stripe-key", regex: /(sk|pk)_(test|live)_[A-Za-z0-9]{24,}/g },
  { label: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { label: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g },
  // Generic key/secret/password assignments — matches `KEY=value`, `key: "value"`, etc.
  // The negative lookahead `(?!\[redacted-)` skips values that have already been
  // redacted by a more-specific earlier pattern. Capture group 2 = secret value.
  {
    label: "kv-secret",
    regex:
      /(?<key>(?:api[_-]?key|secret|password|token|authorization|bearer))\s*[:=]\s*["']?(?!\[redacted-)([^\s"'`,;]{8,})/gi,
    isKv: true,
  },
];

const SENSITIVE_PATH_PATTERNS = [
  /\.env(\..*)?$/i,
  /credentials?$/i,
  /\.aws\//,
  /\.ssh\//,
  /\.gnupg\//,
  /\.docker\/config\.json/,
  /\.kube\/config/,
  /\/secrets?\//i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa($|\.pub$)/,
  /id_ed25519($|\.pub$)/,
];

// ────────────────────────────────────────────────────────────────────────────
// Hash helper for stable redaction tags
// ────────────────────────────────────────────────────────────────────────────

function sha8(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

// ────────────────────────────────────────────────────────────────────────────
// Generic regex pass
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run all SECRET_PATTERNS over a string. Returns redacted string + count.
 * Identical secrets get identical redaction tags so duplicates collapse.
 */
export function redactSecretsInText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", redactedCount: 0 };
  }
  let out = text;
  let count = 0;
  for (const { label, regex, isKv } of SECRET_PATTERNS) {
    out = out.replace(regex, (...args) => {
      count++;
      if (isKv) {
        // For key=value patterns, only mask the value (capture group 2)
        const fullMatch = args[0];
        const keyName = args[1];
        const value = args[2];
        return `${keyName}=[redacted-${label}-${sha8(value)}]`;
      }
      const match = args[0];
      return `[redacted-${label}-${sha8(match)}]`;
    });
  }
  return { text: out, redactedCount: count };
}

// ────────────────────────────────────────────────────────────────────────────
// Sensitive path detection
// ────────────────────────────────────────────────────────────────────────────

export function isSensitivePath(path) {
  if (typeof path !== "string") return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

export function redactSensitivePath(path) {
  if (!isSensitivePath(path)) return path;
  return "[redacted-sensitive-path]";
}

// ────────────────────────────────────────────────────────────────────────────
// Tool-specific redactors
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bash: scrub command, drop stdout, keep exit code + stderr summary.
 * @param {object} input { command, description? }
 * @param {object} output { stdout, stderr, returncode? } or string
 */
function redactBash(input, output) {
  const command = typeof input?.command === "string" ? input.command : "";
  const { text: scrubbedCmd } = redactSecretsInText(command);

  let stderrSummary = "";
  let exitCode = null;
  if (output && typeof output === "object") {
    if (typeof output.stderr === "string" && output.stderr.length > 0) {
      const { text } = redactSecretsInText(output.stderr.slice(0, 500));
      stderrSummary = text;
    }
    if (typeof output.returncode === "number") exitCode = output.returncode;
  }

  return {
    summary: {
      tool: "Bash",
      command_redacted: scrubbedCmd,
      command_hash: sha8(command),
      stderr_summary: stderrSummary,
      exit_code: exitCode,
      stdout_dropped: true,
    },
    captured_full_payload: false,
  };
}

/**
 * Read: store path + bytes only, NEVER content. Sensitive paths replaced.
 */
function redactRead(input, output) {
  const path = typeof input?.file_path === "string" ? input.file_path : "";
  const safePath = redactSensitivePath(path);
  const bytes = typeof output === "string" ? output.length : (output?.content?.length ?? 0);
  return {
    summary: {
      tool: "Read",
      file_path: safePath,
      bytes,
      content_dropped: true,
    },
    captured_full_payload: false,
  };
}

/**
 * Edit / Write: store path + line count, NEVER content.
 */
function redactEditWrite(toolName, input) {
  const path = typeof input?.file_path === "string" ? input.file_path : "";
  const safePath = redactSensitivePath(path);
  const oldLineCount =
    typeof input?.old_string === "string" ? input.old_string.split("\n").length : 0;
  const newLineCount =
    typeof input?.new_string === "string"
      ? input.new_string.split("\n").length
      : typeof input?.content === "string"
      ? input.content.split("\n").length
      : 0;
  return {
    summary: {
      tool: toolName,
      file_path: safePath,
      old_lines: oldLineCount,
      new_lines: newLineCount,
      content_dropped: true,
    },
    captured_full_payload: false,
  };
}

/**
 * Grep / Glob: store pattern + result count, NEVER matched lines.
 */
function redactGrepGlob(toolName, input, output) {
  const pattern = typeof input?.pattern === "string" ? input.pattern : "";
  const path = typeof input?.path === "string" ? input.path : null;
  const resultCount =
    typeof output === "string"
      ? output.split("\n").filter((l) => l.length > 0).length
      : Array.isArray(output)
      ? output.length
      : 0;
  return {
    summary: {
      tool: toolName,
      pattern,
      path: path ? redactSensitivePath(path) : null,
      result_count: resultCount,
      content_dropped: true,
    },
    captured_full_payload: false,
  };
}

/**
 * WebFetch / WebSearch: store URL host + path, strip query string entirely.
 */
function redactWebFetch(toolName, input) {
  const url = typeof input?.url === "string" ? input.url : "";
  let safeUrl = url;
  try {
    if (url) {
      const u = new URL(url);
      safeUrl = `${u.protocol}//${u.host}${u.pathname}`;
    }
  } catch {
    safeUrl = "[invalid-url]";
  }
  return {
    summary: {
      tool: toolName,
      url: safeUrl,
      query_stripped: true,
    },
    captured_full_payload: false,
  };
}

/**
 * Generic fallback for tools we don't have specific handlers for.
 * Applies generic regex pass on stringified input/output, truncates to 200 chars.
 */
function redactGeneric(toolName, input, output) {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? {}).slice(0, 500);
  const outputStr =
    typeof output === "string" ? output : JSON.stringify(output ?? {}).slice(0, 500);
  const { text: safeInput, redactedCount: ric } = redactSecretsInText(inputStr);
  const { text: safeOutput, redactedCount: roc } = redactSecretsInText(outputStr);
  return {
    summary: {
      tool: toolName,
      input_summary: safeInput.slice(0, 200),
      output_summary: safeOutput.slice(0, 200),
      input_redactions: ric,
      output_redactions: roc,
    },
    captured_full_payload: false,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Redact a tool call before writing to buffer.
 *
 * @param {object} args
 * @param {string} args.tool_name - Claude Code tool name
 * @param {object} args.tool_input - Tool input
 * @param {string|object} args.tool_output - Tool result
 * @param {boolean} [args.captureFullPayloads=false] - If true, opt-in mode that still applies generic regex but skips per-tool dropping
 *
 * @returns {object} { summary, captured_full_payload }
 */
export function redactToolCall({ tool_name, tool_input, tool_output, captureFullPayloads = false }) {
  if (!tool_name) {
    return { summary: { tool: "unknown" }, captured_full_payload: false };
  }

  // If user opts in to full payloads, run generic regex but keep more content
  if (captureFullPayloads) {
    return redactGeneric(tool_name, tool_input, tool_output);
  }

  switch (tool_name) {
    case "Bash":
      return redactBash(tool_input, tool_output);
    case "Read":
      return redactRead(tool_input, tool_output);
    case "Edit":
    case "Write":
      return redactEditWrite(tool_name, tool_input);
    case "Grep":
    case "Glob":
      return redactGrepGlob(tool_name, tool_input, tool_output);
    case "WebFetch":
    case "WebSearch":
      return redactWebFetch(tool_name, tool_input);
    // Safe tools — no redaction needed but generic pass still applied for
    // safety on agent-supplied content
    case "TodoWrite":
    case "Task":
    case "AskUserQuestion":
      return redactGeneric(tool_name, tool_input, tool_output);
    default:
      return redactGeneric(tool_name, tool_input, tool_output);
  }
}

/**
 * Redact a user prompt — full text retained, but secrets in the prompt are masked.
 */
export function redactUserPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt : String(prompt ?? "");
  const { text: redacted, redactedCount } = redactSecretsInText(text);
  return { prompt: redacted, redactedCount };
}
