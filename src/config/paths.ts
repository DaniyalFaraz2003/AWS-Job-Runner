import { existsSync } from "node:fs";
import { join } from "node:path";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";

export const ECTL_DIR_NAME = ".ectl";

export function findProjectRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    const ectlDir = join(current, ECTL_DIR_NAME);
    if (existsSync(ectlDir)) {
      return current;
    }

    const parent = join(current, "..");
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function requireProjectRoot(startDir: string): string {
  const root = findProjectRoot(startDir);
  if (root === null) {
    throw new EctlError(
      ECTL_ERROR_CODES.NOT_INITIALIZED,
      "No .ectl/ directory found. Run `ectl init` in your project directory.",
    );
  }

  return root;
}

export function getEctlDir(projectRoot: string): string {
  return join(projectRoot, ECTL_DIR_NAME);
}

export function getConfigPath(projectRoot: string): string {
  return join(getEctlDir(projectRoot), "config.json");
}

export function getEctlignorePath(projectRoot: string): string {
  return join(projectRoot, ".ectlignore");
}

export function getTasksDir(projectRoot: string): string {
  return join(getEctlDir(projectRoot), "tasks");
}

export function getTaskDir(projectRoot: string, taskName: string): string {
  return join(getTasksDir(projectRoot), taskName);
}

export function getStatePath(projectRoot: string, taskName: string): string {
  return join(getTaskDir(projectRoot, taskName), "state.json");
}

export function getRunPath(projectRoot: string, taskName: string): string {
  return join(getTaskDir(projectRoot, taskName), "run.json");
}

export function getKeysDir(projectRoot: string): string {
  return join(getEctlDir(projectRoot), "keys");
}

export function getPrivateKeyPath(projectRoot: string): string {
  return join(getKeysDir(projectRoot), "ectl-key.pem");
}

export function getLogsDir(projectRoot: string): string {
  return join(getEctlDir(projectRoot), "logs");
}

export function ectlDirExists(projectRoot: string): boolean {
  return existsSync(getEctlDir(projectRoot));
}
