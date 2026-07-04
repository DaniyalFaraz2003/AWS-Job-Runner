import { basename } from "node:path";

/** Derive a stable slug from the project directory name for AWS resource naming. */
export function deriveProjectSlug(projectRoot: string): string {
  const raw = basename(projectRoot);
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "project";
}

export function buildKeyPairName(projectSlug: string): string {
  return `ectl-${projectSlug}-key`;
}
