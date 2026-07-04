import {
  createAwsProvisionerForConfig,
  type AwsProvisioner,
} from "../aws/aws-provisioner.js";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { requireProjectRoot } from "../config/paths.js";
import {
  createStateStore,
  type ActiveTask,
  type StateStore,
} from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import type { EctlConfig } from "../types/config.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import {
  isActiveTaskStatus,
  type TaskState,
  type TaskStatus,
} from "../types/state.js";

export interface TerminateTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
}

export interface TerminateTaskResult {
  readonly taskName: string;
  readonly status: TaskStatus;
  readonly instanceId: string;
  readonly securityGroupId: string;
  readonly alreadyTerminated: boolean;
}

export interface TerminateProgress {
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
}

export interface TaskTerminatorDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createAwsProvisioner?: (config: EctlConfig) => AwsProvisioner;
  readonly now?: () => Date;
}

export class TaskTerminator {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createAwsProvisionerFn: (config: EctlConfig) => AwsProvisioner;
  private readonly now: () => Date;

  constructor(deps: TaskTerminatorDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createAwsProvisionerFn =
      deps.createAwsProvisioner ?? createAwsProvisionerForConfig;
    this.now = deps.now ?? (() => new Date());
  }

  async terminate(
    input: TerminateTaskInput,
    progress?: TerminateProgress,
  ): Promise<TerminateTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    progress?.beginStep("Reading project configuration");
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();
    progress?.completeStep(config.region);

    progress?.beginStep("Resolving task to terminate");
    const resolved = await resolveTerminableTask(stateStore, input.taskName);
    const { taskName, state } = resolved;
    progress?.completeStep(`'${taskName}' (${state.status})`);

    if (resolved.alreadyTerminated) {
      return {
        taskName,
        status: state.status,
        instanceId: state.instanceId,
        securityGroupId: state.securityGroupId,
        alreadyTerminated: true,
      };
    }

    const provisioner = this.createAwsProvisionerFn(config);

    if (state.instanceId.trim().length > 0) {
      progress?.beginStep(`Terminating instance ${state.instanceId}`);
      try {
        await provisioner.terminateInstance(state.instanceId);
      } catch (error) {
        progress?.failStep?.("instance termination failed");
        throw error;
      }
      progress?.completeStep("terminated");
    } else {
      progress?.beginStep("Skipping instance termination");
      progress?.completeStep("no instance ID recorded");
    }

    if (state.securityGroupId.trim().length > 0) {
      progress?.beginStep(`Deleting security group ${state.securityGroupId}`);
      try {
        const exists = await provisioner.securityGroupExists(
          state.securityGroupId,
        );
        if (exists) {
          await provisioner.deleteSecurityGroup(state.securityGroupId);
          progress?.completeStep("deleted");
        } else {
          progress?.completeStep("already removed");
        }
      } catch (error) {
        progress?.failStep?.("security group deletion failed");
        throw error;
      }
    } else {
      progress?.beginStep("Skipping security group deletion");
      progress?.completeStep("no security group ID recorded");
    }

    const updatedState: TaskState = {
      ...state,
      status: "terminated",
      updatedAt: this.now().toISOString(),
    };
    await stateStore.writeState(taskName, updatedState);

    return {
      taskName,
      status: updatedState.status,
      instanceId: state.instanceId,
      securityGroupId: state.securityGroupId,
      alreadyTerminated: false,
    };
  }
}

export function createTaskTerminator(
  deps: TaskTerminatorDeps = {},
): TaskTerminator {
  return new TaskTerminator(deps);
}

interface TerminableTaskResolution {
  readonly taskName: string;
  readonly state: TaskState;
  readonly alreadyTerminated: boolean;
}

async function resolveTerminableTask(
  stateStore: StateStore,
  taskNameInput?: string,
): Promise<TerminableTaskResolution> {
  if (taskNameInput !== undefined) {
    const taskName = resolveTaskName(taskNameInput);
    const state = await stateStore.readState(taskName);
    if (state === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.NO_ACTIVE_TASK,
        `Task '${taskName}' not found. Run \`ectl launch\` first.`,
      );
    }

    if (state.status === "terminated") {
      return { taskName, state, alreadyTerminated: true };
    }

    assertTerminableState(taskName, state);
    return { taskName, state, alreadyTerminated: false };
  }

  const active: ActiveTask = await stateStore.assertActiveTask();
  assertTerminableState(active.taskName, active.state);
  return {
    taskName: active.taskName,
    state: active.state,
    alreadyTerminated: false,
  };
}

function assertTerminableState(taskName: string, state: TaskState): void {
  if (!isActiveTaskStatus(state.status)) {
    throw new EctlError(
      ECTL_ERROR_CODES.NO_ACTIVE_TASK,
      `Task '${taskName}' is ${state.status} and cannot be terminated.`,
    );
  }
}
