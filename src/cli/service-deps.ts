import {
  createAwsProvisioner,
  createAwsProvisionerForConfig,
  type AwsProvisionerDeps,
} from "../aws/aws-provisioner.js";
import { createProjectInitializer } from "../config/project-initializer.js";
import type { EctlConfig } from "../types/config.js";
import { createTaskLauncher, type TaskLauncherDeps } from "../orchestration/task-launcher.js";
import {
  createTaskOrchestrator,
  type TaskOrchestratorDeps,
} from "../orchestration/task-orchestrator.js";
import {
  createTaskStatusChecker,
  type TaskStatusCheckerDeps,
} from "../orchestration/task-status.js";
import {
  createTaskTerminator,
  type TaskTerminatorDeps,
} from "../orchestration/task-terminator.js";
import { awsProvisionerDeps, type CliContext } from "./context.js";

function withAwsProvisioner<T extends TaskLauncherDeps>(
  ctx: CliContext,
  base: T = {} as T,
): T {
  const deps = awsProvisionerDeps(ctx);
  return {
    ...base,
    createAwsProvisioner: (config: EctlConfig) =>
      createAwsProvisionerForConfig(config, deps),
  };
}

export function createLauncherForContext(ctx: CliContext) {
  return createTaskLauncher(withAwsProvisioner(ctx));
}

export function createStatusCheckerForContext(ctx: CliContext) {
  return createTaskStatusChecker(withAwsProvisioner(ctx));
}

export function createTerminatorForContext(ctx: CliContext) {
  return createTaskTerminator(withAwsProvisioner(ctx));
}

export function createOrchestratorForContext(ctx: CliContext) {
  const launcherDeps = withAwsProvisioner(ctx);
  const deps: TaskOrchestratorDeps = {
    createTaskLauncher: () => createTaskLauncher(launcherDeps),
  };
  return createTaskOrchestrator(deps);
}

export function createInitializerForContext(ctx: CliContext) {
  const deps: AwsProvisionerDeps = awsProvisionerDeps(ctx);
  return createProjectInitializer({
    createProvisioner: (region) => createAwsProvisioner(region, deps),
  });
}
