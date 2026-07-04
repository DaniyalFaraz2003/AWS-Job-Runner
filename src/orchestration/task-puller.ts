import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import {
  getPrivateKeyPath,
  getTaskLogsDir,
  requireProjectRoot,
} from "../config/paths.js";
import {
  createStateStore,
  type StateStore,
} from "../state/state-store.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import {
  createTransferManager,
  type PulledArtifact,
  type TransferManager,
} from "../transfer/transfer-manager.js";
import type { TransferProgressHandlers } from "../transfer/progress.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { resolveReachableTask } from "./resolve-reachable-task.js";

export interface PullTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
  readonly output?: string;
  readonly paths?: string;
}

export interface PullTaskResult {
  readonly taskName: string;
  readonly localDest: string;
  readonly artifacts: readonly PulledArtifact[];
  readonly publicIp: string;
  readonly instanceId: string;
}

export interface PullProgress {
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
}

export interface TaskPullerDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
  readonly createTransferManager?: (ssh: SshManager) => TransferManager;
}

export class TaskPuller {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createTransferManagerFn: (ssh: SshManager) => TransferManager;

  constructor(deps: TaskPullerDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.createTransferManagerFn =
      deps.createTransferManager ??
      ((ssh) => createTransferManager({ ssh }));
  }

  async pull(
    input: PullTaskInput,
    progress?: PullProgress,
  ): Promise<PullTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    progress?.beginStep("Reading project configuration");
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();
    progress?.completeStep();

    progress?.beginStep("Resolving task for artifact download");
    let taskName: string;
    let publicIp: string;
    let instanceId: string;
    try {
      const resolved = await resolveReachableTask(stateStore, input.taskName);
      taskName = resolved.taskName;
      publicIp = resolved.state.publicIp;
      instanceId = resolved.state.instanceId;
    } catch (error) {
      progress?.failStep?.("task not reachable");
      throw error;
    }
    progress?.completeStep(`'${taskName}'`);

    const artifactPaths = resolveArtifactPaths(
      config.artifactPaths,
      input.paths,
    );
    const localDest =
      input.output !== undefined
        ? resolve(projectRoot, input.output)
        : getTaskLogsDir(projectRoot, taskName);

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      progress?.failStep?.("Private key missing");
      throw new EctlError(
        ECTL_ERROR_CODES.NOT_INITIALIZED,
        `Private key not found at ${keyPath}. Run \`ectl init\` first.`,
      );
    }

    progress?.beginStep(`Connecting to ${config.sshUser}@${publicIp}`);
    const ssh = this.createSshManagerFn();
    let artifacts: PulledArtifact[];
    try {
      await ssh.connect(publicIp, keyPath, config.sshUser, {
        onRetry: ({ attempt, maxAttempts, delayMs }) => {
          const delaySeconds = Math.ceil(delayMs / 1000);
          progress?.updateStep(
            `Connecting to ${config.sshUser}@${publicIp} (${String(attempt)}/${String(maxAttempts)} failed, retry in ${String(delaySeconds)}s)…`,
          );
        },
      });
      progress?.completeStep("connected");

      const transferManager = this.createTransferManagerFn(ssh);
      const transferProgress = createPullProgress(progress);

      artifacts = await transferManager.pullArtifacts({
        paths: artifactPaths,
        remoteWorkDir: config.remoteWorkDir,
        localDest,
        ...(transferProgress !== undefined ? { progress: transferProgress } : {}),
      });
    } catch (error) {
      progress?.failStep?.("Artifact download failed");
      throw error;
    } finally {
      ssh.dispose();
    }

    return {
      taskName,
      localDest,
      artifacts,
      publicIp,
      instanceId,
    };
  }
}

export function createTaskPuller(deps: TaskPullerDeps = {}): TaskPuller {
  return new TaskPuller(deps);
}

function resolveArtifactPaths(
  configPaths: readonly string[],
  pathsFlag: string | undefined,
): string[] {
  if (pathsFlag !== undefined) {
    const parsed = pathsFlag
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (parsed.length === 0) {
      throw new EctlError(
        ECTL_ERROR_CODES.ARTIFACT_PATHS_EMPTY,
        "No artifact paths provided. Pass comma-separated paths via `--paths` or set `artifactPaths` in `.ectl/config.json`.",
      );
    }

    return parsed;
  }

  return [...configPaths];
}

function createPullProgress(
  progress: PullProgress | undefined,
): TransferProgressHandlers | undefined {
  if (progress === undefined) {
    return undefined;
  }

  return {
    onPullStart(artifactPath) {
      progress.beginStep(`Downloading ${artifactPath}`);
    },
    onPullComplete(artifactPath, localPath) {
      progress.completeStep(localPath);
    },
  };
}
