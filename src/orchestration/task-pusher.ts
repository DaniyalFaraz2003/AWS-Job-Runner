import { existsSync } from "node:fs";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createStateStore,
  type ActiveTask,
  type StateStore,
} from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import {
  BootstrapScript,
  createBootstrapScript,
} from "../process/bootstrap-script.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import {
  createTransferManager,
  type TransferManager,
} from "../transfer/transfer-manager.js";
import type { TransferProgressHandlers } from "../transfer/progress.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskState, TaskStatus } from "../types/state.js";
import { formatBytes } from "../util/format-bytes.js";

const PUSHABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "stopped",
] as const;

export interface PushTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
}

export interface PushTaskResult {
  readonly taskName: string;
  readonly remoteWorkDir: string;
  readonly publicIp: string;
  readonly instanceId: string;
}

export interface PushProgress {
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
}

export interface TaskPusherDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
  readonly createBootstrapScript?: (ssh: SshManager) => BootstrapScript;
  readonly createTransferManager?: (ssh: SshManager) => TransferManager;
}

export class TaskPusher {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createBootstrapScriptFn: (ssh: SshManager) => BootstrapScript;
  private readonly createTransferManagerFn: (ssh: SshManager) => TransferManager;

  constructor(deps: TaskPusherDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.createBootstrapScriptFn =
      deps.createBootstrapScript ??
      ((ssh) => createBootstrapScript({ ssh }));
    this.createTransferManagerFn =
      deps.createTransferManager ??
      ((ssh) => createTransferManager({ ssh }));
  }

  async push(
    input: PushTaskInput,
    progress?: PushProgress,
  ): Promise<PushTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    progress?.beginStep("Reading project configuration");
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();
    progress?.completeStep(config.remoteWorkDir);

    progress?.beginStep("Resolving task for upload");
    let activeTask: ActiveTask;
    try {
      activeTask = await resolvePushableTask(stateStore, input.taskName);
    } catch (error) {
      progress?.failStep?.("task not ready for push");
      throw error;
    }
    const { taskName, state } = activeTask;
    progress?.completeStep(`'${taskName}' (${state.status})`);

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      progress?.failStep?.("Private key missing");
      throw new EctlError(
        ECTL_ERROR_CODES.NOT_INITIALIZED,
        `Private key not found at ${keyPath}. Run \`ectl init\` first.`,
      );
    }

    progress?.beginStep(
      `Connecting to ${config.sshUser}@${state.publicIp}`,
    );
    const ssh = this.createSshManagerFn();
    try {
      await ssh.connect(state.publicIp, keyPath, config.sshUser, {
        onRetry: ({ attempt, maxAttempts, delayMs }) => {
          const delaySeconds = Math.ceil(delayMs / 1000);
          progress?.updateStep(
            `Connecting to ${config.sshUser}@${state.publicIp} (${String(attempt)}/${String(maxAttempts)} failed, retry in ${String(delaySeconds)}s)…`,
          );
        },
      });
      progress?.completeStep("connected");

      progress?.beginStep("Ensuring transfer packages on instance");
      const bootstrap = this.createBootstrapScriptFn(ssh);
      await bootstrap.ensureBasePackages();
      progress?.completeStep("curl, unzip");

      const transferManager = this.createTransferManagerFn(ssh);
      const transferProgress = createTransferProgress(progress, config.remoteWorkDir);

      await transferManager.pushProject({
        projectRoot,
        remoteWorkDir: config.remoteWorkDir,
        ...(transferProgress !== undefined ? { progress: transferProgress } : {}),
      });
    } catch (error) {
      progress?.failStep?.("Upload failed");
      throw error;
    } finally {
      ssh.dispose();
    }

    return {
      taskName,
      remoteWorkDir: config.remoteWorkDir,
      publicIp: state.publicIp,
      instanceId: state.instanceId,
    };
  }
}

export function createTaskPusher(deps: TaskPusherDeps = {}): TaskPusher {
  return new TaskPusher(deps);
}

async function resolvePushableTask(
  stateStore: StateStore,
  taskNameInput?: string,
): Promise<ActiveTask> {
  if (taskNameInput !== undefined) {
    const taskName = resolveTaskName(taskNameInput);
    const state = await stateStore.readState(taskName);
    if (state === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.NO_ACTIVE_TASK,
        `Task '${taskName}' not found. Run \`ectl launch\` first.`,
      );
    }

    assertPushableState(taskName, state);
    return { taskName, state };
  }

  const active = await stateStore.assertActiveTask();
  assertPushableState(active.taskName, active.state);
  return active;
}

function assertPushableState(taskName: string, state: TaskState): void {
  if (!(PUSHABLE_TASK_STATUSES as readonly string[]).includes(state.status)) {
    throw new EctlError(
      ECTL_ERROR_CODES.NO_ACTIVE_TASK,
      `Task '${taskName}' is ${state.status}. Push requires a running or stopped task with a public IP. Run \`ectl launch\` first.`,
    );
  }

  if (state.publicIp.trim().length === 0) {
    throw new EctlError(
      ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
      `Task '${taskName}' has no public IP. Check default VPC settings or run \`ectl status\`.`,
    );
  }
}

function createTransferProgress(
  progress: PushProgress | undefined,
  remoteWorkDir: string,
): TransferProgressHandlers | undefined {
  if (progress === undefined) {
    return undefined;
  }

  return {
    onArchiveStart() {
      progress.beginStep("Building project archive");
    },
    onArchiveProgress(processedBytes) {
      progress.updateStep(
        `Building project archive · ${formatBytes(processedBytes)}`,
      );
    },
    onArchiveComplete(totalBytes) {
      progress.completeStep(formatBytes(totalBytes));
    },
    onUploadStart(totalBytes) {
      progress.beginStep(`Uploading archive · ${formatBytes(totalBytes)}`);
    },
    onUploadProgress(transferred, total) {
      progress.updateStep(
        `Uploading archive · ${formatBytes(transferred)} / ${formatBytes(total)}`,
      );
    },
    onUploadComplete() {
      progress.completeStep();
    },
    onUnzipStart() {
      progress.beginStep("Extracting on remote instance");
    },
    onUnzipComplete() {
      progress.completeStep(remoteWorkDir);
    },
  };
}
