import { existsSync } from "node:fs";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createProcessManager,
  type ProcessManager,
} from "../process/process-manager.js";
import {
  createStateStore,
  type StateStore,
} from "../state/state-store.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskState, TaskStatus } from "../types/state.js";
import { resolveReachableTask } from "./resolve-reachable-task.js";

export interface StopTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
}

export interface StopTaskResult {
  readonly taskName: string;
  readonly processName: string;
  readonly status: TaskStatus;
  readonly publicIp: string;
  readonly instanceId: string;
  readonly alreadyStopped: boolean;
}

export interface StopProgress {
  onConnecting?(host: string): void;
  onConnected?(): void;
}

export interface TaskStopperDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
  readonly createProcessManager?: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  readonly now?: () => Date;
}

export class TaskStopper {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createProcessManagerFn: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  private readonly now: () => Date;

  constructor(deps: TaskStopperDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.createProcessManagerFn =
      deps.createProcessManager ??
      ((ssh, stateStore) => createProcessManager({ ssh, stateStore }));
    this.now = deps.now ?? (() => new Date());
  }

  async stop(
    input: StopTaskInput,
    progress?: StopProgress,
  ): Promise<StopTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();

    const { taskName, state } = await resolveReachableTask(
      stateStore,
      input.taskName,
    );

    const run = await stateStore.readRun(taskName);
    const processName = run?.pm2ProcessName ?? taskName;

    if (state.status === "stopped") {
      return {
        taskName,
        processName,
        status: state.status,
        publicIp: state.publicIp,
        instanceId: state.instanceId,
        alreadyStopped: true,
      };
    }

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      throw new EctlError(
        ECTL_ERROR_CODES.NOT_INITIALIZED,
        `Private key not found at ${keyPath}. Run \`ectl init\` first.`,
      );
    }

    const host = `${config.sshUser}@${state.publicIp}`;
    progress?.onConnecting?.(host);

    const ssh = this.createSshManagerFn();
    try {
      await ssh.connect(state.publicIp, keyPath, config.sshUser);
      progress?.onConnected?.();

      const processManager = this.createProcessManagerFn(ssh, stateStore);
      await processManager.stopProcess(processName);
    } finally {
      ssh.dispose();
    }

    const updatedState: TaskState = {
      ...state,
      status: "stopped",
      updatedAt: this.now().toISOString(),
    };
    await stateStore.writeState(taskName, updatedState);

    return {
      taskName,
      processName,
      status: updatedState.status,
      publicIp: state.publicIp,
      instanceId: state.instanceId,
      alreadyStopped: false,
    };
  }
}

export function createTaskStopper(deps: TaskStopperDeps = {}): TaskStopper {
  return new TaskStopper(deps);
}
