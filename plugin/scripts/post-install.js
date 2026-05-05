#!/usr/bin/env node
/**
 * Sprintra @sprintra/plugin postinstall — VP-1298.
 *
 * Materializes @sprintra/cli into the npm cache so `sprintra transcript`
 * works without an explicit global install. Also creates ~/.sprintra/ dir
 * with proper permissions (0700) if not present.
 *
 * Best-effort: any failure is non-fatal (npm install must complete).
 */

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function ensureSprintraDir() {
  const dir = join(process.env.HOME || homedir(), ".sprintra");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Non-fatal
  }
}

function tryMaterializeCli() {
  // Use spawn with detached so this doesn't block npm install if network is
  // slow. Best-effort: hides output to keep install logs clean. Users can
  // run `npx @sprintra/cli@latest --version` manually if this fails.
  return new Promise((resolve) => {
    const child = spawn("npx", ["--yes", "@sprintra/cli@latest", "--version"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    child.unref();
    // Don't wait for completion — let it run in background
    setTimeout(resolve, 100);
  });
}

async function main() {
  // Skip if explicit opt-out
  if (process.env.SPRINTRA_SKIP_POSTINSTALL === "1") return;

  await ensureSprintraDir();
  await tryMaterializeCli();
}

main().catch(() => {
  // Postinstall scripts must NEVER fail the parent npm install. Swallow.
  process.exit(0);
});
