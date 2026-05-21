/**
 * Reviews CLI installer for Valet runner startup.
 *
 * Checks if the `reviews` binary is available and installs it if not.
 * Called during runner startup before OpenCode launches.
 */

import { execSync, spawnSync } from 'node:child_process';

export interface InstallResult {
  installed: boolean;
  version?: string;
  error?: string;
}

/**
 * Get the installed version of the reviews binary, or null if not found.
 */
function getInstalledVersion(): string | null {
  try {
    const result = spawnSync('reviews', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the reviews binary is already installed.
 */
function isReviewsInstalled(): boolean {
  // Check via PATH first
  const result = spawnSync('which', ['reviews'], { encoding: 'utf-8', timeout: 5000 });
  if (result.status === 0) return true;

  // Fall back to checking known install location
  try {
    const fs = require('node:fs');
    return fs.existsSync('/usr/local/bin/reviews');
  } catch {
    return false;
  }
}

/**
 * Install the Reviews CLI using the official install script.
 * Passes --no-skills to skip installing Codex-specific skill symlinks.
 */
export async function installReviewsCli(): Promise<InstallResult> {
  // Check if already installed
  if (isReviewsInstalled()) {
    const version = getInstalledVersion();
    return { installed: true, version: version ?? undefined };
  }

  console.log('[Reviews] reviews CLI not found — installing via install script...');

  try {
    execSync(
      'curl -fsSL https://raw.githubusercontent.com/figitaki/reviews/main/install.sh | sh -s -- --no-skills',
      {
        stdio: 'inherit',
        timeout: 120_000, // 2 minutes
        shell: '/bin/sh',
      },
    );

    // Verify installation succeeded
    if (isReviewsInstalled()) {
      const version = getInstalledVersion();
      console.log(`[Reviews] reviews CLI installed successfully${version ? ` (${version})` : ''}`);
      return { installed: true, version: version ?? undefined };
    } else {
      const msg = 'Install script ran but reviews binary not found afterwards';
      console.warn(`[Reviews] ${msg}`);
      return { installed: false, error: msg };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Reviews] Failed to install reviews CLI: ${msg}`);
    return { installed: false, error: msg };
  }
}
