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
  beginStep(label: string): void;
  updateStep(label: string): void;
  completeStep(detail?: string): void;
  failStep?(message?: string): void;
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

    progress?.beginStep("Reading project configuration");
    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();
    progress?.completeStep(`${config.region} · ${config.instanceType}`);

    progress?.beginStep("Checking for active tasks");
    try {
      await stateStore.assertNoActiveTask();
    } catch (error) {
      progress?.failStep?.("another task is still active");
      throw error;
    }
    progress?.completeStep("none active");

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      progress?.failStep?.("Private key missing");
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

    progress?.beginStep("Preparing local task state");
    await stateStore.writeState(taskName, provisioningState);
    progress?.completeStep(`task '${taskName}'`);

    const provisioner = this.createAwsProvisionerFn(config);
    let amiId = config.amiId;
    if (amiId === undefined || amiId.length === 0) {
      progress?.beginStep("Resolving Ubuntu AMI");
      amiId = await resolveAmiId(config, provisioner);
      progress?.completeStep(amiId);
    }

    progress?.beginStep("Provisioning AWS resources");
    let resources: LaunchTaskResourcesResult;
    try {
      resources = await provisioner.launchTaskResources({
        config,
        taskName,
        amiId,
        allowAnyIp,
        createdAt,
        onProgress: (message) => {
          progress?.updateStep(message);
        },
      });
    } catch (error) {
      progress?.failStep?.("AWS provisioning failed");
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
    progress?.completeStep(
      `${resources.instance.instanceId} · ${resources.instance.publicIp}`,
    );

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

    progress?.beginStep("Saving instance details to task state");
    await stateStore.writeState(taskName, withInstanceState);
    progress?.completeStep(resources.securityGroup.securityGroupId);

    progress?.beginStep(
      `Verifying SSH to ${config.sshUser}@${resources.instance.publicIp}`,
    );
    const ssh = this.createSshManagerFn();
    try {
      await ssh.connect(
        resources.instance.publicIp,
        keyPath,
        config.sshUser,
        {
          onRetry: ({ attempt, maxAttempts, delayMs }) => {
            const delaySeconds = Math.ceil(delayMs / 1000);
            progress?.updateStep(
              `Verifying SSH (${attempt}/${String(maxAttempts)} failed, retry in ${String(delaySeconds)}s)…`,
            );
          },
        },
      );
    } catch (error) {
      progress?.failStep?.("SSH verification failed");
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
    progress?.completeStep("connected");

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

    progress?.beginStep("Finalizing task status");
    await stateStore.writeState(taskName, runningState);
    progress?.completeStep("running");

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
