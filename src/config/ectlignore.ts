import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { getEctlignorePath } from "./paths.js";

/** Default patterns created by `ectl init` (SRS §4.5). */
export const DEFAULT_ECTLIGNORE_PATTERNS = [
  "node_modules/",
  ".git/",
  ".ectl/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
] as const;

export function createEctlignore(
  patterns: readonly string[] = DEFAULT_ECTLIGNORE_PATTERNS,
): Ignore {
  return ignore().add([...patterns]);
}

export function parseEctlignore(content: string): Ignore {
  const ig = ignore();
  ig.add(content);
  return ig;
}

export async function loadEctlignore(projectRoot: string): Promise<Ignore> {
  const path = getEctlignorePath(projectRoot);

  try {
    const content = await readFile(path, "utf8");
    return parseEctlignore(content);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return createEctlignore();
    }
    throw error;
  }
}

export function defaultEctlignoreContent(): string {
  return `${DEFAULT_ECTLIGNORE_PATTERNS.join("\n")}\n`;
}
