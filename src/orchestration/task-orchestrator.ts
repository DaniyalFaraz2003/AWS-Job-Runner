import { requireProjectRoot } from "../config/paths.js";
import { resolveRunCommand } from "../process/resolve-run-command.js";
import {
  createStateStore,
  type StateStore,
} from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import {
  ECTL_ERROR_CODES,
  EctlError,
  isEctlError,
  toEctlError,
} from "../types/errors.js";
import type { TaskRun } from "../types/run.js";
import type { TaskState, TaskStatus } from "../types/state.js";
import {
  createTaskLauncher,
  type LaunchProgress,
  type LaunchTaskResult,
  type TaskLauncher,
} from "./task-launcher.js";
import {
  createTaskPusher,
  type PushProgress,
  type PushTaskResult,
  type TaskPusher,
} from "./task-pusher.js";
import {
  createTaskRunner,
  type RunProgress,
  type RunTaskResult,
  type TaskRunner,
} from "./task-runner.js";

export interface DeployTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
  readonly run?: string;
  readonly allowAnyIp?: boolean;
}

export interface DeployTaskResult {
  readonly taskName: string;
  readonly instanceId: string;
  readonly publicIp: string;
  readonly status: TaskStatus;
  readonly remoteWorkDir: string;
  readonly run: TaskRun;
}

export interface DeployProgress {
  beginPhase(phase: DeployPhase): void;
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
}

export type DeployPhase = "launch" | "push" | "run";

export interface TaskOrchestratorDeps {
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createTaskLauncher?: () => TaskLauncher;
  readonly createTaskPusher?: () => TaskPusher;
  readonly createTaskRunner?: () => TaskRunner;
  readonly now?: () => Date;
}

const PHASE_LABELS: Record<DeployPhase, string> = {
  launch: "Launch",
  push: "Push",
  run: "Run",
};

export class TaskOrchestrator {
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createTaskLauncherFn: () => TaskLauncher;
  private readonly createTaskPusherFn: () => TaskPusher;
  private readonly createTaskRunnerFn: () => TaskRunner;
  private readonly now: () => Date;

  constructor(deps: TaskOrchestratorDeps = {}) {
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createTaskLauncherFn = deps.createTaskLauncher ?? createTaskLauncher;
    this.createTaskPusherFn = deps.createTaskPusher ?? createTaskPusher;
    this.createTaskRunnerFn = deps.createTaskRunner ?? createTaskRunner;
    this.now = deps.now ?? (() => new Date());
  }

  async deploy(
    input: DeployTaskInput,
    progress?: DeployProgress,
  ): Promise<DeployTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());
    const taskName = resolveTaskName(input.taskName);
    const allowAnyIp = input.allowAnyIp ?? false;

    resolveRunCommand(input.run, projectRoot);

    const stateStore = this.createStateStoreFn(projectRoot);
    const launcher = this.createTaskLauncherFn();
    const pusher = this.createTaskPusherFn();
    const runner = this.createTaskRunnerFn();

    let launchResult: LaunchTaskResult | undefined;
    let pushResult: PushTaskResult | undefined;

    try {
      progress?.beginPhase("launch");
      launchResult = await launcher.launch(
        { projectRoot, taskName, allowAnyIp },
        progress ? createPhaseProgress(progress, "launch") : undefined,
      );

      progress?.beginPhase("push");
      pushResult = await pusher.push(
        { projectRoot, taskName },
        progress ? createPhaseProgress(progress, "push") : undefined,
      );

      progress?.beginPhase("run");
      const runResult = await runner.run(
        {
          projectRoot,
          taskName,
          ...(input.run !== undefined ? { run: input.run } : {}),
        },
        progress ? createPhaseProgress(progress, "run") : undefined,
      );

      return {
        taskName: runResult.taskName,
        instanceId: runResult.instanceId,
        publicIp: runResult.publicIp,
        status: runResult.status,
        remoteWorkDir: runResult.run.remoteWorkDir,
        run: runResult.run,
      };
    } catch (error) {
      const failedState = await markDeployFailed(stateStore, taskName, this.now);

      if (shouldReportPartialFailure(failedState, launchResult, pushResult)) {
        throwDeployPartialFailure(taskName, failedState, error);
      }

      throw error;
    }
  }
}

export function createTaskOrchestrator(
  deps: TaskOrchestratorDeps = {},
): TaskOrchestrator {
  return new TaskOrchestrator(deps);
}

function createPhaseProgress(
  progress: DeployProgress,
  phase: DeployPhase,
): LaunchProgress & PushProgress & RunProgress {
  const prefix = PHASE_LABELS[phase];

  return {
    beginStep(label: string) {
      progress.beginStep(`${prefix}: ${label}`);
    },
    updateStep(label: string) {
      progress.updateStep(`${prefix}: ${label}`);
    },
    completeStep(detail?: string) {
      progress.completeStep(detail);
    },
    failStep(message?: string) {
      progress.failStep?.(message);
    },
  };
}

async function markDeployFailed(
  stateStore: StateStore,
  taskName: string,
  now: () => Date,
): Promise<TaskState | null> {
  const state = await stateStore.readState(taskName);
  if (state === null || state.status === "terminated") {
    return state;
  }

  const failedState: TaskState = {
    ...state,
    status: "failed",
    updatedAt: now().toISOString(),
  };
  await stateStore.writeState(taskName, failedState);
  return failedState;
}

function shouldReportPartialFailure(
  state: TaskState | null,
  launchResult: LaunchTaskResult | undefined,
  pushResult: PushTaskResult | undefined,
): boolean {
  if (launchResult !== undefined || pushResult !== undefined) {
    return true;
  }

  return state !== null && state.instanceId.trim().length > 0;
}

function throwDeployPartialFailure(
  taskName: string,
  state: TaskState | null,
  cause: unknown,
): never {
  const underlying = isEctlError(cause) ? cause : toEctlError(cause);
  const lines = [
    `Deploy failed for task '${taskName}': ${underlying.message}`,
  ];

  if (state !== null && state.instanceId.trim().length > 0) {
    lines.push(`Instance: ${state.instanceId}`);
  }
  if (state !== null && state.publicIp.trim().length > 0) {
    lines.push(`Public IP: ${state.publicIp}`);
  }

  lines.push(
    "",
    "AWS resources were left running for debugging.",
    "Recovery:",
    "  ectl status",
    "  ectl ssh",
    "  ectl terminate",
  );

  throw new EctlError(
    ECTL_ERROR_CODES.DEPLOY_PARTIAL_FAILURE,
    lines.join("\n"),
    cause,
  );
}
