import { existsSync } from "node:fs";
import type { DescribeInstanceResult } from "../aws/instance-lifecycle.js";
import {
  createAwsProvisionerForConfig,
  type AwsProvisioner,
} from "../aws/aws-provisioner.js";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createProcessManager,
  type ProcessManager,
} from "../process/process-manager.js";
import type { Pm2ProcessInfo } from "../process/pm2-commands.js";
import { createStateStore, type StateStore } from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import type { RetryPolicyOptions } from "../ssh/retry-policy.js";
import type { EctlConfig } from "../types/config.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskRun } from "../types/run.js";
import type { TaskState, TaskStatus } from "../types/state.js";

export interface StatusTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
}

export interface StatusReconciliation {
  readonly instanceFound: boolean;
  readonly awsInstanceState?: string;
  readonly securityGroupFound: boolean;
  readonly publicIpChanged: boolean;
  readonly warnings: readonly string[];
}

export interface TaskStatusSnapshot {
  readonly taskName: string;
  readonly state: TaskState;
  readonly run: TaskRun | null;
  readonly reconciliation: StatusReconciliation;
  readonly pm2: Pm2ProcessInfo | null;
  readonly pm2Unreachable: boolean;
}

export interface NoActiveTaskSnapshot {
  readonly noActiveTask: true;
}

export type StatusTaskResult = TaskStatusSnapshot | NoActiveTaskSnapshot;

export function isNoActiveTaskResult(
  result: StatusTaskResult,
): result is NoActiveTaskSnapshot {
  return "noActiveTask" in result && result.noActiveTask === true;
}

export interface TaskStatusCheckerDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createAwsProvisioner?: (config: EctlConfig) => AwsProvisioner;
  readonly createSshManager?: () => SshManager;
  readonly createProcessManager?: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  readonly sshRetryPolicy?: RetryPolicyOptions;
  readonly now?: () => Date;
}

const STATUS_SSH_RETRY_POLICY: RetryPolicyOptions = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
};

export class TaskStatusChecker {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createAwsProvisionerFn: (config: EctlConfig) => AwsProvisioner;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createProcessManagerFn: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
  private readonly sshRetryPolicy: RetryPolicyOptions;
  private readonly now: () => Date;

  constructor(deps: TaskStatusCheckerDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createAwsProvisionerFn =
      deps.createAwsProvisioner ?? createAwsProvisionerForConfig;
    this.sshRetryPolicy = deps.sshRetryPolicy ?? STATUS_SSH_RETRY_POLICY;
    this.createSshManagerFn =
      deps.createSshManager ??
      (() => createSshManager({ retryPolicy: this.sshRetryPolicy }));
    this.createProcessManagerFn =
      deps.createProcessManager ??
      ((ssh, stateStore) => createProcessManager({ ssh, stateStore }));
    this.now = deps.now ?? (() => new Date());
  }

  async status(input: StatusTaskInput = {}): Promise<StatusTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();

    const resolved = await resolveStatusTask(stateStore, input.taskName);
    if (resolved === null) {
      return { noActiveTask: true };
    }

    const { taskName, state: initialState } = resolved;
    const reconciledAt = this.now().toISOString();
    const warnings: string[] = [];

    let state = initialState;
    let instanceFound = false;
    let awsInstanceState: string | undefined;
    let publicIpChanged = false;
    let securityGroupFound = true;

    if (state.instanceId.length > 0) {
      const provisioner = this.createAwsProvisionerFn(config);
      const described = await provisioner.tryDescribeInstance(state.instanceId);

      if (described === null) {
        instanceFound = false;
        warnings.push(
          `EC2 instance '${state.instanceId}' no longer exists in AWS. Local state updated to terminated.`,
        );
        state = {
          ...state,
          status: "terminated",
          updatedAt: reconciledAt,
        };
      } else {
        instanceFound = true;
        awsInstanceState = described.stateName;
        const synced = syncStateFromAwsInstance(state, described, reconciledAt);
        state = synced.state;
        publicIpChanged = synced.publicIpChanged;
      }
    }

    if (state.securityGroupId.length > 0) {
      const provisioner = this.createAwsProvisionerFn(config);
      securityGroupFound = await provisioner.securityGroupExists(
        state.securityGroupId,
      );
      if (!securityGroupFound) {
        warnings.push(
          `Security group '${state.securityGroupId}' was not found in AWS.`,
        );
      }
    }

    state = {
      ...state,
      lastReconciledAt: reconciledAt,
    };
    await stateStore.writeState(taskName, state);

    const run = await stateStore.readRun(taskName);
    const pm2Result = await this.queryPm2Status({
      projectRoot,
      config,
      state,
      run,
      instanceFound,
    });

    return {
      taskName,
      state,
      run,
      reconciliation: {
        instanceFound,
        ...(awsInstanceState !== undefined ? { awsInstanceState } : {}),
        securityGroupFound,
        publicIpChanged,
        warnings,
      },
      pm2: pm2Result.pm2,
      pm2Unreachable: pm2Result.pm2Unreachable,
    };
  }

  private async queryPm2Status(options: {
    projectRoot: string;
    config: EctlConfig;
    state: TaskState;
    run: TaskRun | null;
    instanceFound: boolean;
  }): Promise<{ pm2: Pm2ProcessInfo | null; pm2Unreachable: boolean }> {
    if (
      !options.instanceFound ||
      !canQueryPm2Status(options.state) ||
      options.state.publicIp.trim().length === 0
    ) {
      return { pm2: null, pm2Unreachable: false };
    }

    const keyPath = getPrivateKeyPath(options.projectRoot);
    if (!existsSync(keyPath)) {
      return { pm2: null, pm2Unreachable: true };
    }

    const ssh = this.createSshManagerFn();
    const stateStore = this.createStateStoreFn(options.projectRoot);

    try {
      await ssh.connect(
        options.state.publicIp,
        keyPath,
        options.config.sshUser,
      );
      const processManager = this.createProcessManagerFn(ssh, stateStore);
      const processes = await processManager.listProcesses();
      const processName =
        options.run?.pm2ProcessName ?? options.state.taskName;
      const match =
        processes.find((process) => process.name === processName) ?? null;
      return { pm2: match, pm2Unreachable: false };
    } catch {
      return { pm2: null, pm2Unreachable: true };
    } finally {
      ssh.dispose();
    }
  }
}

export function createTaskStatusChecker(
  deps: TaskStatusCheckerDeps = {},
): TaskStatusChecker {
  return new TaskStatusChecker(deps);
}

async function resolveStatusTask(
  stateStore: StateStore,
  taskNameInput?: string,
): Promise<{ taskName: string; state: TaskState } | null> {
  if (taskNameInput !== undefined) {
    const taskName = resolveTaskName(taskNameInput);
    const state = await stateStore.readState(taskName);
    if (state === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.NO_ACTIVE_TASK,
        `Task '${taskName}' not found. Run \`ectl launch\` first.`,
      );
    }

    return { taskName, state };
  }

  const active = await stateStore.getActiveTask();
  if (active === null) {
    return null;
  }

  return active;
}

export function syncStateFromAwsInstance(
  state: TaskState,
  described: DescribeInstanceResult,
  reconciledAt: string,
): { state: TaskState; publicIpChanged: boolean } {
  let next = state;
  let publicIpChanged = false;

  if (
    described.publicIp.length > 0 &&
    described.publicIp !== state.publicIp
  ) {
    publicIpChanged = true;
    next = {
      ...next,
      publicIp: described.publicIp,
      updatedAt: reconciledAt,
    };
  }

  const mappedStatus = mapAwsInstanceStateToTaskStatus(
    described.stateName,
    next.status,
  );
  if (mappedStatus !== next.status) {
    next = {
      ...next,
      status: mappedStatus,
      updatedAt: reconciledAt,
    };
  }

  return { state: next, publicIpChanged };
}

function mapAwsInstanceStateToTaskStatus(
  awsStateName: string | undefined,
  currentStatus: TaskStatus,
): TaskStatus {
  switch (awsStateName) {
    case "terminated":
    case "shutting-down":
      return "terminated";
    case "stopped":
    case "stopping":
      if (currentStatus === "provisioning" || currentStatus === "running") {
        return "stopped";
      }
      return currentStatus;
    case "running":
      if (currentStatus === "provisioning") {
        return "running";
      }
      return currentStatus;
    default:
      return currentStatus;
  }
}

function canQueryPm2Status(state: TaskState): boolean {
  return (
    state.status === "running" ||
    state.status === "stopped" ||
    state.status === "failed"
  );
}
