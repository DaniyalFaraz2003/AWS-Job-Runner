import { existsSync } from "node:fs";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createProcessManager,
  parseNodeMajorVersion,
  resolveRunCommand,
  type ProcessManager,
} from "../process/index.js";
import {
  createStateStore,
  type ActiveTask,
  type StateStore,
} from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskRun } from "../types/run.js";
import type { TaskState, TaskStatus } from "../types/state.js";

const RUNNABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "stopped",
] as const;

export interface RunTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
  readonly run?: string;
}

export interface RunTaskResult {
  readonly taskName: string;
  readonly run: TaskRun;
  readonly status: TaskStatus;
  readonly publicIp: string;
  readonly instanceId: string;
}

export interface RunProgress {
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
}

export interface TaskRunnerDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
  readonly createProcessManager?: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  readonly now?: () => Date;
}

export class TaskRunner {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createProcessManagerFn: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  private readonly now: () => Date;

  constructor(deps: TaskRunnerDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.createProcessManagerFn =
      deps.createProcessManager ??
      ((ssh, stateStore) => createProcessManager({ ssh, stateStore }));
    this.now = deps.now ?? (() => new Date());
  }

  async run(
    input: RunTaskInput,
    progress?: RunProgress,
  ): Promise<RunTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    progress?.beginStep("Reading project configuration");
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();
    progress?.completeStep(config.remoteWorkDir);

    progress?.beginStep("Resolving run command");
    const resolved = resolveRunCommand(input.run, projectRoot);
    progress?.completeStep(
      resolved.source === "run.sh" ? ".ectl/run.sh" : resolved.command,
    );

    progress?.beginStep("Resolving task for run");
    let activeTask: ActiveTask;
    try {
      activeTask = await resolveRunnableTask(stateStore, input.taskName);
    } catch (error) {
      progress?.failStep?.("task not ready for run");
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

    const nodeVersion =
      config.nodeVersion ?? parseNodeMajorVersion(process.version);

    progress?.beginStep(
      `Connecting to ${config.sshUser}@${state.publicIp}`,
    );
    const ssh = this.createSshManagerFn();
    let run: TaskRun;
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

      progress?.beginStep("Bootstrapping remote environment");
      const processManager = this.createProcessManagerFn(ssh, stateStore);
      run = await processManager.startProcess({
        taskName,
        command: resolved.command,
        source: resolved.source,
        remoteWorkDir: config.remoteWorkDir,
        nodeVersion,
      });
      progress?.completeStep(`Node ${nodeVersion}, pm2`);

      progress?.beginStep(`Starting pm2 process '${taskName}'`);
      progress?.completeStep(resolved.command);
    } catch (error) {
      progress?.failStep?.("Run failed");
      throw error;
    } finally {
      ssh.dispose();
    }

    progress?.beginStep("Updating task state");
    const updatedState: TaskState = {
      ...state,
      status: "running",
      updatedAt: this.now().toISOString(),
    };
    await stateStore.writeState(taskName, updatedState);
    progress?.completeStep("running");

    return {
      taskName,
      run,
      status: updatedState.status,
      publicIp: state.publicIp,
      instanceId: state.instanceId,
    };
  }
}

export function createTaskRunner(deps: TaskRunnerDeps = {}): TaskRunner {
  return new TaskRunner(deps);
}

async function resolveRunnableTask(
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

    assertRunnableState(taskName, state);
    return { taskName, state };
  }

  const active = await stateStore.assertActiveTask();
  assertRunnableState(active.taskName, active.state);
  return active;
}

function assertRunnableState(taskName: string, state: TaskState): void {
  if (!(RUNNABLE_TASK_STATUSES as readonly string[]).includes(state.status)) {
    throw new EctlError(
      ECTL_ERROR_CODES.NO_ACTIVE_TASK,
      `Task '${taskName}' is ${state.status}. Run requires a running or stopped task with a public IP. Run \`ectl launch\` and \`ectl push\` first.`,
    );
  }

  if (state.publicIp.trim().length === 0) {
    throw new EctlError(
      ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
      `Task '${taskName}' has no public IP. Check default VPC settings or run \`ectl status\`.`,
    );
  }
}
