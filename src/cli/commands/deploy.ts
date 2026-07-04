import type { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskOrchestrator,
  type DeployPhase,
  type DeployProgress,
  type DeployTaskResult,
} from "../../orchestration/task-orchestrator.js";
import { resolveTaskName } from "../../state/task-name.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { StepProgressReporter } from "../output/step-progress.js";
import { ECTL_ERROR_CODES, isEctlError } from "../../types/errors.js";

export interface DeployCommandOptions {
  readonly name?: string;
  readonly run?: string;
  readonly allowAnyIp?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

const ALLOW_ANY_IP_WARNING =
  "SECURITY WARNING: SSH ingress will allow connections from 0.0.0.0/0 (any IP). " +
  "This exposes port 22 to the entire internet.";

const PHASE_HEADERS: Record<DeployPhase, string> = {
  launch: "Phase 1 — Launch EC2 instance",
  push: "Phase 2 — Upload project",
  run: "Phase 3 — Start process",
};

function resolveContext(
  getContext: () => CliContext,
  local: DeployCommandOptions,
  root: DeployCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

async function confirmAllowAnyIp(ctx: CliContext): Promise<boolean> {
  if (ctx.json) {
    console.error(chalk.yellow(ALLOW_ANY_IP_WARNING));
    return true;
  }

  console.log(chalk.yellow(ALLOW_ANY_IP_WARNING));
  return confirm({
    message: "Allow SSH from any IP (0.0.0.0/0)?",
    default: false,
  });
}

function createDeployProgress(reporter: StepProgressReporter): DeployProgress {
  return {
    beginPhase(phase: DeployPhase) {
      reporter.printSection(PHASE_HEADERS[phase]);
    },
    beginStep(label: string) {
      reporter.beginStep(label);
    },
    updateStep(label: string) {
      reporter.updateStep(label);
    },
    completeStep(detail?: string) {
      reporter.completeStep(detail);
    },
    failStep(message?: string) {
      reporter.failStep(message);
    },
  };
}

function printDeploySuccess(result: DeployTaskResult): void {
  console.log("");
  console.log(
    chalk.green.bold(`Task '${result.taskName}' deployed successfully.`),
  );
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${result.publicIp}`);
  console.log(`  ${chalk.dim("Remote dir")}    ${result.remoteWorkDir}`);
  console.log(`  ${chalk.dim("Status")}        ${chalk.green(result.status)}`);
  console.log(`  ${chalk.dim("Command")}       ${result.run.command}`);
  console.log(`  ${chalk.dim("Source")}        ${result.run.source}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim(
      "Next: `ectl logs default --follow` to stream output, or `ectl status`.",
    ),
  );
  console.log("");
}

function printDeployFailure(error: unknown): void {
  if (
    isEctlError(error) &&
    error.code === ECTL_ERROR_CODES.DEPLOY_PARTIAL_FAILURE
  ) {
    console.error(chalk.red.bold("Deploy failed — resources left running."));
    console.error("");
    console.error(error.message);
    return;
  }

  if (isEctlError(error)) {
    console.error(chalk.red(error.message));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
}

export async function runDeployCommand(
  options: DeployCommandOptions,
  ctx: CliContext,
): Promise<void> {
  const taskName = resolveTaskName(options.name);
  const allowAnyIp = options.allowAnyIp ?? false;

  if (allowAnyIp) {
    const confirmed = await confirmAllowAnyIp(ctx);
    if (!confirmed) {
      throw new Error("Deploy cancelled.");
    }
  }

  logVerbose(
    ctx,
    `Deploying task '${taskName}' (allowAnyIp=${String(allowAnyIp)})${
      options.run !== undefined ? ` with run: ${options.run}` : ""
    }`,
  );

  const orchestrator = createTaskOrchestrator();
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      `ectl deploy — task ${chalk.cyan(`'${taskName}'`)}`,
      "Launch, upload, and run in one step. Status checks may take several minutes.",
    );
  }

  try {
    const result = await orchestrator.deploy(
      {
        taskName,
        allowAnyIp,
        ...(options.run !== undefined ? { run: options.run } : {}),
      },
      reporter ? createDeployProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("deploy", result));
      return;
    }

    printDeploySuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerDeployCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("deploy")
    .description("Launch an instance, upload the project, and start the task")
    .option("--name <task>", "Task name (default: default)")
    .option(
      "--run <command>",
      'Shell command to run (overrides .ectl/run.sh if present)',
    )
    .option(
      "--allow-any-ip",
      "Allow SSH from 0.0.0.0/0 instead of your public IP only",
    )
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<DeployCommandOptions>();
      const root = this.parent?.opts<DeployCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runDeployCommand(local, ctx);
      } catch (error) {
        if (ctx.json) {
          printJson(envelopeFromError("deploy", error));
        } else {
          printDeployFailure(error);
        }
        process.exit(1);
      }
    });
}
