/**
 * Sprintra Memory Layer Phase 6 — Auto-attach project marker.
 *
 * Story: VP-1293. Spec: doc-7N8zPoZC.
 *
 * The dominant cause of the founder's 6-day RCA gap: hooks silent-exit when
 * `findProjectMarker(cwd) === null`. This module provides a fallback so
 * Phase 6 hooks NEVER silent-exit:
 *
 *   1. Try findProjectMarker(cwd) — same as today
 *   2. If null, try matchProjectByRepoPath(cwd) — if a Sprintra project
 *      already exists with repo_path === cwd, write .sprintra/project.json
 *      automatically and return that project_id
 *   3. If still no match, return an "unattached bucket" sentinel — captures
 *      still go to local buffer with project_id="__unattached__" and the
 *      user gets a one-time systemMessage prompting them to run /sprintra-attach
 *
 * The buffer never silently drops events.
 */

import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { findProjectMarker, httpRequest } from "./hook-context.js";

function getHome() {
  return process.env.HOME || homedir();
}

const SEEN_REPOS_FILE = () => join(getHome(), ".sprintra", "seen-repos.json");

export const UNATTACHED_PROJECT_ID = "__unattached__";

/**
 * Read ~/.sprintra/seen-repos.json (tracks which cwds we've already prompted).
 */
async function readSeenRepos() {
  try {
    const raw = await readFile(SEEN_REPOS_FILE(), "utf-8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function recordSeenRepo(cwd) {
  const seen = await readSeenRepos();
  seen[cwd] = Date.now();
  try {
    await mkdir(join(getHome(), ".sprintra"), { recursive: true, mode: 0o700 });
    await writeFile(SEEN_REPOS_FILE(), JSON.stringify(seen, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal — worst case we re-prompt the user once
  }
}

/**
 * Query the API for a project matching this cwd's repo_path.
 * Returns null if no match, network error, etc.
 */
async function matchProjectByRepoPath(cwd, apiUrl, token) {
  if (!apiUrl || !token) return null;
  const res = await httpRequest(
    "GET",
    `${apiUrl}/api/projects?repo_path=${encodeURIComponent(cwd)}`,
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    null,
    3000,
  );
  if (!res || !res.ok || !res.body) return null;
  try {
    const parsed = JSON.parse(res.body);
    const projects = Array.isArray(parsed) ? parsed : parsed.projects ?? [];
    const match = projects.find((p) => p.repo_path === cwd);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write .sprintra/project.json at the given dir.
 * Also adds .sprintra/ to .gitignore if not already present.
 */
async function writeMarker(rootDir, projectId, source = "auto") {
  const sprintraDir = join(rootDir, ".sprintra");
  await mkdir(sprintraDir, { recursive: true });
  const markerPath = join(sprintraDir, "project.json");
  const marker = {
    project_id: projectId,
    repo_path: rootDir,
    attached_at: Date.now(),
    source,
  };
  await writeFile(markerPath, JSON.stringify(marker, null, 2), { mode: 0o644 });

  // Add to .gitignore if absent
  const gitignorePath = join(rootDir, ".gitignore");
  let gitignore = "";
  try {
    gitignore = await readFile(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — create one
  }
  const lines = gitignore.split("\n");
  const hasEntry = lines.some(
    (l) => l.trim() === ".sprintra/" || l.trim() === ".sprintra",
  );
  if (!hasEntry) {
    const next = (gitignore.endsWith("\n") || gitignore === "" ? gitignore : gitignore + "\n") +
      "# Sprintra project marker (local)\n.sprintra/\n";
    try {
      await writeFile(gitignorePath, next);
    } catch {
      // Non-fatal
    }
  }

  return marker;
}

/**
 * Detect git repo root by walking up looking for .git directory.
 */
async function findGitRoot(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 20; depth++) {
    try {
      const s = await stat(join(dir, ".git"));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch {}
    const parent = join(dir, "..");
    const resolved = await safeRealpath(parent);
    if (resolved === dir) break;
    dir = resolved;
  }
  return null;
}

async function safeRealpath(p) {
  try {
    const fs = await import("node:fs/promises");
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Main entry point. Called from session-start.js (and as a fallback in other
 * hooks) when findProjectMarker returns null.
 *
 * Returns:
 *   { project_id, source, marker_path?, was_unattached: boolean, prompt_user: boolean }
 *
 * Never throws. Never silent-exits — always returns a usable project_id
 * (either real or UNATTACHED_PROJECT_ID).
 */
export async function autoAttach({ cwd, apiUrl, token }) {
  // 1. Already attached?
  const existing = await findProjectMarker(cwd);
  if (existing) {
    return {
      project_id: existing.project_id,
      source: "marker",
      marker_path: existing._marker_path,
      was_unattached: false,
      prompt_user: false,
    };
  }

  // 2. Try to find git root and match by repo_path
  const gitRoot = await findGitRoot(cwd);
  const rootDir = gitRoot || cwd;

  if (apiUrl && token) {
    const matchedProjectId = await matchProjectByRepoPath(rootDir, apiUrl, token);
    if (matchedProjectId) {
      const marker = await writeMarker(rootDir, matchedProjectId, "auto-matched");
      return {
        project_id: matchedProjectId,
        source: "auto-matched",
        marker_path: join(rootDir, ".sprintra", "project.json"),
        was_unattached: false,
        prompt_user: false,
      };
    }
  }

  // 3. Unattached bucket — prompt user once per repo
  const seen = await readSeenRepos();
  const promptUser = !seen[rootDir];
  if (promptUser) await recordSeenRepo(rootDir);

  return {
    project_id: UNATTACHED_PROJECT_ID,
    source: "unattached",
    was_unattached: true,
    prompt_user: promptUser,
    repo_path: rootDir,
  };
}

/**
 * Render a one-time systemMessage prompting the user to attach.
 * Returns a string suitable for SessionStart's hookSpecificOutput.systemMessage.
 */
export function unattachedSystemMessage(repoPath) {
  return [
    "Sprintra is capturing this session locally but no project is linked.",
    `Repo: ${repoPath}`,
    "",
    "Run /sprintra-attach to link this repo to a Sprintra project,",
    "or `sprintra attach <project-id>` from your terminal.",
    "",
    "Captures will be safely held in your local buffer until you attach.",
  ].join("\n");
}
