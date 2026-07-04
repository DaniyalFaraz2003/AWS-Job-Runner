import type { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  type LaunchProgress,
  type LaunchTaskResult,
} from "../../orchestration/task-launcher.js";
import { resolveTaskName } from "../../state/task-name.js";
import {
  createSuccessEnvelope,
  printJson,
} from "../output/envelope.js";
import { handleCommandError } from "../output/command-error.js";
import { createLauncherForContext } from "../service-deps.js";
import { StepProgressReporter } from "../output/step-progress.js";

export interface LaunchCommandOptions {
  readonly name?: string;
  readonly allowAnyIp?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

const ALLOW_ANY_IP_WARNING =
  "SECURITY WARNING: SSH ingress will allow connections from 0.0.0.0/0 (any IP). " +
  "This exposes port 22 to the entire internet.";

function resolveContext(
  getContext: () => CliContext,
  local: LaunchCommandOptions,
  root: LaunchCommandOptions | undefined,
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

function createLaunchProgress(reporter: StepProgressReporter): LaunchProgress {
  return {
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

function printLaunchSuccess(result: LaunchTaskResult): void {
  const { taskName, state } = result;
  console.log("");
  console.log(chalk.green.bold(`Task '${taskName}' is ready.`));
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${state.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${state.publicIp}`);
  console.log(`  ${chalk.dim("Security grp")}  ${state.securityGroupId}`);
  console.log(`  ${chalk.dim("Status")}        ${chalk.green(state.status)}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim("Next: `ectl push` to upload your project, then `ectl run`."),
  );
  console.log("");
}

export async function runLaunchCommand(
  options: LaunchCommandOptions,
  ctx: CliContext,
): Promise<void> {
  const taskName = resolveTaskName(options.name);
  const allowAnyIp = options.allowAnyIp ?? false;

  if (allowAnyIp) {
    const confirmed = await confirmAllowAnyIp(ctx);
    if (!confirmed) {
      throw new Error("Launch cancelled.");
    }
  }

  logVerbose(ctx, `Launching task '${taskName}' (allowAnyIp=${String(allowAnyIp)})`);

  const launcher = createLauncherForContext(ctx);
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      `ectl launch — task ${chalk.cyan(`'${taskName}'`)}`,
      "Provisioning EC2 resources. Status checks may take several minutes.",
    );
  }

  try {
    const result = await launcher.launch(
      {
        taskName,
        allowAnyIp,
      },
      reporter ? createLaunchProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("launch", result));
      return;
    }

    printLaunchSuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerLaunchCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("launch")
    .description("Provision an EC2 instance and security group for a task")
    .option("--name <task>", "Task name (default: default)")
    .option(
      "--allow-any-ip",
      "Allow SSH from 0.0.0.0/0 instead of your public IP only",
    )
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<LaunchCommandOptions>();
      const root = this.parent?.opts<LaunchCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runLaunchCommand(local, ctx);
      } catch (error) {
        handleCommandError(ctx, "launch", error);
      }
    });
}
