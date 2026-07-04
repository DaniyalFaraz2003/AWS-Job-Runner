import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SshManager } from "../ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import {
  ArchiveBuilder,
  createArchiveBuilder,
  type BuildArchiveResult,
} from "./archive-builder.js";
import type { TransferProgressHandlers } from "./progress.js";
import {
  buildRemotePathKindCommand,
  buildRemoteZipPath,
  buildUnzipCommand,
  parseRemotePathKind,
  resolveLocalArtifactPath,
  resolveRemotePath,
  shellQuote,
} from "./remote-paths.js";

export interface PushProjectOptions {
  readonly projectRoot: string;
  readonly remoteWorkDir: string;
  readonly progress?: TransferProgressHandlers;
}

export interface PullArtifactsOptions {
  readonly paths: readonly string[];
  readonly remoteWorkDir: string;
  readonly localDest: string;
  readonly progress?: TransferProgressHandlers;
}

export interface PulledArtifact {
  readonly artifactPath: string;
  readonly localPath: string;
  readonly kind: "file" | "directory";
}

export interface TransferManagerDeps {
  readonly ssh: SshManager;
  readonly archiveBuilder?: ArchiveBuilder;
}

export class TransferManager {
  private readonly ssh: SshManager;
  private readonly archiveBuilder: ArchiveBuilder;

  constructor(deps: TransferManagerDeps) {
    this.ssh = deps.ssh;
    this.archiveBuilder = deps.archiveBuilder ?? createArchiveBuilder();
  }

  /** Build zip, upload via SFTP, and unzip on the remote instance (FR-PUSH-1–3). */
  async pushProject(options: PushProjectOptions): Promise<void> {
    let archive: BuildArchiveResult | null = null;

    try {
      archive = await this.archiveBuilder.build({
        projectRoot: options.projectRoot,
        ...(options.progress !== undefined
          ? { progress: options.progress }
          : {}),
      });

      const remoteZipPath = buildRemoteZipPath(options.remoteWorkDir);

      options.progress?.onUploadStart?.(archive.totalBytes);

      await this.ssh.putFile(archive.archivePath, remoteZipPath, {
        onProgress: (transferred, _chunk, total) => {
          options.progress?.onUploadProgress?.(transferred, total);
        },
      });

      options.progress?.onUploadComplete?.();

      options.progress?.onUnzipStart?.();

      const unzipResult = await this.ssh.execCommand(
        buildUnzipCommand(remoteZipPath, options.remoteWorkDir),
      );

      if (unzipResult.code !== 0) {
        throw new EctlError(
          ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
          `Remote unzip failed: ${unzipResult.stderr || unzipResult.stdout}. Try \`ectl ssh\` to inspect the instance.`,
        );
      }

      options.progress?.onUnzipComplete?.();

      await this.ssh.execCommand(`rm -f ${shellQuote(remoteZipPath)}`);
    } finally {
      if (archive !== null) {
        await archive.cleanup();
      }
    }
  }

  /** Download configured artifact paths to a local destination (FR-PULL-1–2). */
  async pullArtifacts(
    options: PullArtifactsOptions,
  ): Promise<PulledArtifact[]> {
    if (options.paths.length === 0) {
      throw new EctlError(
        ECTL_ERROR_CODES.ARTIFACT_PATHS_EMPTY,
        "No artifact paths configured. Set `artifactPaths` in `.ectl/config.json` or pass `--paths`.",
      );
    }

    await mkdir(options.localDest, { recursive: true });

    const pulled: PulledArtifact[] = [];

    for (const artifactPath of options.paths) {
      options.progress?.onPullStart?.(artifactPath);

      const remotePath = resolveRemotePath(artifactPath, options.remoteWorkDir);
      const localPath = resolveLocalArtifactPath(
        options.localDest,
        artifactPath,
      );

      const kindResult = await this.ssh.execCommand(
        buildRemotePathKindCommand(remotePath),
      );
      const kind = parseRemotePathKind(kindResult.stdout);

      if (kind === "missing") {
        throw new EctlError(
          ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
          `Remote artifact not found: ${remotePath}. Verify \`artifactPaths\` in config and that the task produced output.`,
        );
      }

      if (kind === "directory") {
        await mkdir(localPath, { recursive: true });
        await this.ssh.getDirectory(remotePath, localPath);
      } else {
        await mkdir(dirname(localPath), { recursive: true });
        await this.ssh.getFile(remotePath, localPath);
      }

      options.progress?.onPullComplete?.(artifactPath, localPath);

      pulled.push({ artifactPath, localPath, kind });
    }

    return pulled;
  }
}

export function createTransferManager(deps: TransferManagerDeps): TransferManager {
  return new TransferManager(deps);
}
