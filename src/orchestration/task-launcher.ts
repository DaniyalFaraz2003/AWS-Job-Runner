import { existsSync } from "node:fs";
import {
  createAwsProvisionerForConfig,
  type AwsProvisioner,
  type LaunchTaskResourcesResult,
} from "../aws/aws-provisioner.js";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import { createStateStore, type StateStore } from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import type { EctlConfig } from "../types/config.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskState } from "../types/state.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";

export interface LaunchTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
  readonly allowAnyIp?: boolean;
}

export interface LaunchTaskResult {
  readonly taskName: string;
  readonly state: TaskState;
}

export interface LaunchProgress {
  update(message: string): void;
}

export interface TaskLauncherDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createAwsProvisioner?: (config: EctlConfig) => AwsProvisioner;
  readonly createSshManager?: () => SshManager;
  readonly now?: () => Date;
}

export class TaskLauncher {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createAwsProvisionerFn: (config: EctlConfig) => AwsProvisioner;
  private readonly createSshManagerFn: () => SshManager;
  private readonly now: () => Date;

  constructor(deps: TaskLauncherDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createAwsProvisionerFn =
      deps.createAwsProvisioner ?? createAwsProvisionerForConfig;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.now = deps.now ?? (() => new Date());
  }

  async launch(
    input: LaunchTaskInput,
    progress?: LaunchProgress,
  ): Promise<LaunchTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());
    const taskName = resolveTaskName(input.taskName);
    const allowAnyIp = input.allowAnyIp ?? false;

    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();

    await stateStore.assertNoActiveTask();

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      throw new EctlError(
        ECTL_ERROR_CODES.NOT_INITIALIZED,
        `Private key not found at ${keyPath}. Run \`ectl init\` first.`,
      );
    }

    const createdAt = this.now().toISOString();
    const provisioningState = buildTaskState({
      taskName,
      status: "provisioning",
      config,
      instanceId: "",
      publicIp: "",
      securityGroupId: "",
      createdAt,
      updatedAt: createdAt,
    });

    progress?.update("Creating task state…");
    await stateStore.writeState(taskName, provisioningState);

    const provisioner = this.createAwsProvisionerFn(config);
    const amiId = await resolveAmiId(config, provisioner);

    progress?.update("Provisioning EC2 instance and security group…");
    let resources: LaunchTaskResourcesResult;
    try {
      resources = await provisioner.launchTaskResources({
        config,
        taskName,
        amiId,
        allowAnyIp,
        createdAt,
      });
    } catch (error) {
      await stateStore.writeState(
        taskName,
        buildTaskState({
          taskName,
          status: "failed",
          config,
          instanceId: "",
          publicIp: "",
          securityGroupId: "",
          createdAt,
          updatedAt: this.now().toISOString(),
        }),
      );
      throw error;
    }

    const withInstanceState = buildTaskState({
      taskName,
      status: "provisioning",
      config,
      instanceId: resources.instance.instanceId,
      publicIp: resources.instance.publicIp,
      securityGroupId: resources.securityGroup.securityGroupId,
      createdAt,
      updatedAt: this.now().toISOString(),
    });
    await stateStore.writeState(taskName, withInstanceState);

    progress?.update("Waiting for SSH…");
    const ssh = this.createSshManagerFn();
    try {
      await ssh.connect(
        resources.instance.publicIp,
        keyPath,
        config.sshUser,
      );
    } catch (error) {
      await stateStore.writeState(
        taskName,
        buildTaskState({
          taskName,
          status: "failed",
          config,
          instanceId: resources.instance.instanceId,
          publicIp: resources.instance.publicIp,
          securityGroupId: resources.securityGroup.securityGroupId,
          createdAt,
          updatedAt: this.now().toISOString(),
        }),
      );
      throw error;
    } finally {
      ssh.dispose();
    }

    const runningState = buildTaskState({
      taskName,
      status: "running",
      config,
      instanceId: resources.instance.instanceId,
      publicIp: resources.instance.publicIp,
      securityGroupId: resources.securityGroup.securityGroupId,
      createdAt,
      updatedAt: this.now().toISOString(),
    });
    await stateStore.writeState(taskName, runningState);

    return { taskName, state: runningState };
  }
}

export function createTaskLauncher(deps: TaskLauncherDeps = {}): TaskLauncher {
  return new TaskLauncher(deps);
}

async function resolveAmiId(
  config: EctlConfig,
  provisioner: AwsProvisioner,
): Promise<string> {
  if (config.amiId !== undefined && config.amiId.length > 0) {
    return config.amiId;
  }

  return provisioner.resolveDefaultUbuntuAmiId();
}

function buildTaskState(options: {
  taskName: string;
  status: TaskState["status"];
  config: EctlConfig;
  instanceId: string;
  publicIp: string;
  securityGroupId: string;
  createdAt: string;
  updatedAt: string;
}): TaskState {
  return {
    taskName: options.taskName,
    status: options.status,
    instanceId: options.instanceId,
    publicIp: options.publicIp,
    securityGroupId: options.securityGroupId,
    keyPairName: options.config.keyPairName,
    region: options.config.region,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}
