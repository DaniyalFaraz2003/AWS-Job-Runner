import type { SshManager } from "../ssh/ssh-manager.js";
import { shellQuote } from "../transfer/remote-paths.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";

/** Extract major Node version from config (e.g. "22" or "22.15.0" → "22"). */
export function parseNodeMajorVersion(nodeVersion: string): string {
  const match = /^(\d+)/.exec(nodeVersion.trim());
  const major = match?.[1];
  if (major === undefined) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      `Invalid nodeVersion "${nodeVersion}". Expected a numeric major version such as "22".`,
    );
  }

  return major;
}

/** Returns exit 0 when curl, unzip, node (matching major), npm, and pm2 are present. */
export function buildBootstrapCheckCommand(nodeMajor: string): string {
  const major = shellQuote(nodeMajor);
  return [
    "command -v curl >/dev/null 2>&1",
    "command -v unzip >/dev/null 2>&1",
    "command -v node >/dev/null 2>&1",
    "command -v npm >/dev/null 2>&1",
    "command -v pm2 >/dev/null 2>&1",
    `node -p "process.versions.node.split('.')[0]" | grep -qx ${major}`,
  ].join(" && ");
}

/** Install apt packages, Node via NodeSource, and global pm2 (FR-RUN-2). */
export function buildBootstrapInstallCommand(nodeMajor: string): string {
  const major = parseNodeMajorVersion(nodeMajor);

  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "sudo apt-get update -qq",
    "sudo apt-get install -y -qq curl unzip ca-certificates gnupg",
    `curl -fsSL https://deb.nodesource.com/setup_${major}.x | sudo -E bash -`,
    "sudo apt-get install -y -qq nodejs",
    "sudo npm install -g pm2",
  ].join(" && ");
}

export interface BootstrapScriptDeps {
  readonly ssh: SshManager;
}

export class BootstrapScript {
  private readonly ssh: SshManager;

  constructor(deps: BootstrapScriptDeps) {
    this.ssh = deps.ssh;
  }

  /** Idempotent remote bootstrap — skips install when node+pm2 already match (FR-RUN-2). */
  async ensureReady(nodeVersion: string): Promise<void> {
    const major = parseNodeMajorVersion(nodeVersion);
    const check = await this.ssh.execCommand(buildBootstrapCheckCommand(major));

    if (check.code === 0) {
      return;
    }

    const install = await this.ssh.execCommand(
      buildBootstrapInstallCommand(major),
    );

    if (install.code !== 0) {
      const detail = install.stderr.trim() || install.stdout.trim();
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        detail.length > 0
          ? `Remote bootstrap failed: ${detail}. Try \`ectl ssh\` to debug.`
          : "Remote bootstrap failed. Try `ectl ssh` to debug.",
      );
    }
  }
}

export function createBootstrapScript(deps: BootstrapScriptDeps): BootstrapScript {
  return new BootstrapScript(deps);
}
