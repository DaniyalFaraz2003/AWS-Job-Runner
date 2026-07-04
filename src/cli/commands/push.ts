import type { Command } from "commander";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskPusher,
  type PushProgress,
  type PushTaskResult,
} from "../../orchestration/task-pusher.js";
import {
  createSuccessEnvelope,
  printJson,
} from "../output/envelope.js";
import { handleCommandError } from "../output/command-error.js";
import { StepProgressReporter } from "../output/step-progress.js";

export interface PushCommandOptions {
  readonly name?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: PushCommandOptions,
  root: PushCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function createPushProgress(reporter: StepProgressReporter): PushProgress {
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

function printPushSuccess(result: PushTaskResult): void {
  console.log("");
  console.log(chalk.green.bold(`Project uploaded to task '${result.taskName}'.`));
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${result.publicIp}`);
  console.log(`  ${chalk.dim("Remote dir")}    ${result.remoteWorkDir}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim("Next: `ectl run` to bootstrap and start your process."),
  );
  console.log("");
}

export async function runPushCommand(
  options: PushCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Pushing project${options.name !== undefined ? ` for task '${options.name}'` : ""}`,
  );

  const pusher = createTaskPusher();
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      "ectl push — upload project",
      "Archives your project (honoring .ectlignore), uploads via SFTP, and extracts on the instance.",
    );
  }

  try {
    const result = await pusher.push(
      {
        ...(options.name !== undefined ? { taskName: options.name } : {}),
      },
      reporter ? createPushProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("push", result));
      return;
    }

    printPushSuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerPushCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("push")
    .description("Upload the project archive to the active task instance")
    .option("--name <task>", "Task name (default: active task)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<PushCommandOptions>();
      const root = this.parent?.opts<PushCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runPushCommand(local, ctx);
      } catch (error) {
        handleCommandError(ctx, "push", error);
      }
    });
}
