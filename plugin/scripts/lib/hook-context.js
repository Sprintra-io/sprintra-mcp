/**
 * Shared hook context for Sprintra Claude Code plugin hooks.
 *
 * All hooks (SessionStart, PostToolUse, Stop, SessionEnd) need the same
 * infrastructure: read stdin (with timeout), find .sprintra/project.json
 * via cwd walk-up, resolve API URL + auth from ~/.sprintra/config.json
 * (with smart local-vs-prod fallback), fire-and-forget HTTP, ALWAYS exit 0.
 *
 * Each hook script imports from here and stays small.
 *
 * Decisions: dec-iXgsoPPa (proactive context), dec-r93TDhG4 (.sprintra marker),
 *            dec-v0imTWX3 (multi-user identity), dec-gP07J-Qs (multi-IDE bundling)
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

export const LOCAL_API = "http://127.0.0.1:4000";
export const PROD_API = "https://api.sprintra.io";
export const HEALTH_PROBE_MS = 400;
export const CONFIG_FILE = join(homedir(), ".sprintra", "config.json");

export function debug(prefix, ...args) {
  if (process.env.SPRINTRA_DEBUG) console.error(`[sprintra-${prefix}]`, ...args);
}

/** Read stdin with hard 500ms timeout. Returns parsed JSON or null. */
export function readStdin() {
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
      try { finish(JSON.parse(raw)); }
      catch { finish(null); }
    });
    process.stdin.on("error", () => finish(null));
    timer = setTimeout(() => finish(null), 500);
  });
}

/** Walk up from cwd looking for .sprintra/project.json. */
export async function findProjectMarker(startDir) {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 20; depth++) {
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
  }
  return null;
}

/** Read ~/.sprintra/config.json. Returns {} on any failure. */
export async function readStoredConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/** Probe local API. Returns true if /api/health responds in <400ms. */
export async function isLocalApiUp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_MS);
  try {
    const res = await fetch(`${LOCAL_API}/api/health`, { signal: ctrl.signal, keepalive: false });
    return res.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Pick API URL: env > stored config > live local probe > prod default. */
export async function pickApiUrl(stored) {
  if (process.env.SPRINTRA_API_URL) return process.env.SPRINTRA_API_URL;
  if (stored && stored.apiUrl) return stored.apiUrl;
  if (await isLocalApiUp()) return LOCAL_API;
  return PROD_API;
}

/** Resolve project: env override > marker file > null (silent exit). */
export async function resolveProject(cwd) {
  if (process.env.SPRINTRA_PROJECT_ID) {
    return { project_id: process.env.SPRINTRA_PROJECT_ID, _source: "env" };
  }
  const marker = await findProjectMarker(cwd);
  if (marker) return { ...marker, _source: "marker" };
  return null;
}

/**
 * One-shot resolve: returns { project, apiUrl, token, identity } or null
 * if no project found (caller should silent-exit).
 */
export async function resolveContext(cwd) {
  const project = await resolveProject(cwd);
  if (!project) return null;
  const stored = await readStoredConfig();
  const apiUrl = await pickApiUrl(stored);
  const token = process.env.SPRINTRA_TOKEN || stored.token || null;
  const identity = {
    user_id: stored.user_id || null,
    email: stored.email || null,
    display_name: stored.display_name || null,
  };
  return { project, apiUrl, token, identity, stored };
}

/**
 * Fire-and-forget HTTP request. NEVER throws. Returns { ok, status, body } or null.
 * Hard timeout in ms. Used by all hooks for telemetry posting.
 */
export async function httpRequest(method, url, headers, body, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...headers, connection: "close" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      keepalive: false,
    });
    let respBody = null;
    try { respBody = await res.text(); } catch {}
    return { ok: res.ok, status: res.status, body: respBody };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install a hard wallclock cap. NEVER let a hook exceed this — Claude Code's
 * timeout would kill us anyway, but exiting cleanly avoids ugly stderr.
 */
export function installHardTimeout(ms) {
  const t = setTimeout(() => {
    debug("hook", `hard kill at ${ms}ms`);
    process.exit(0);
  }, ms);
  t.unref();
  return () => clearTimeout(t);
}
