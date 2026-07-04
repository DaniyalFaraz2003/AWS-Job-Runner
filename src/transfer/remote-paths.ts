import { join, posix } from "node:path";

/** Quote a value for safe use in a POSIX shell single-quoted string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve artifact path relative to remoteWorkDir or pass through absolute paths. */
export function resolveRemotePath(
  artifactPath: string,
  remoteWorkDir: string,
): string {
  if (artifactPath.startsWith("/")) {
    return artifactPath;
  }

  const normalized = artifactPath.replace(/^\.\//, "");
  return posix.join(remoteWorkDir, normalized);
}

/** Local destination path preserving artifact relative structure (FR-PULL-2). */
export function resolveLocalArtifactPath(
  localDest: string,
  artifactPath: string,
): string {
  const normalized = artifactPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return join(localDest, ...normalized.split("/"));
}

export type RemotePathKind = "file" | "directory" | "missing";

export function parseRemotePathKind(stdout: string): RemotePathKind {
  const kind = stdout.trim();
  if (kind === "file" || kind === "directory") {
    return kind;
  }
  return "missing";
}

export function buildRemotePathKindCommand(remotePath: string): string {
  const quoted = shellQuote(remotePath);
  return `if [ -d ${quoted} ]; then echo directory; elif [ -f ${quoted} ]; then echo file; else echo missing; fi`;
}

export function buildUnzipCommand(
  remoteZipPath: string,
  remoteWorkDir: string,
): string {
  const zip = shellQuote(remoteZipPath);
  const workDir = shellQuote(remoteWorkDir);
  return `rm -rf ${workDir} && mkdir -p ${workDir} && unzip -o ${zip} -d ${workDir}`;
}

export function buildRemoteZipPath(remoteWorkDir: string): string {
  const parent = posix.dirname(remoteWorkDir);
  return posix.join(parent, "ectl-upload.zip");
}
