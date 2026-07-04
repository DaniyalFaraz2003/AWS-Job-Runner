import type { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskTerminator,
  type TerminateProgress,
  type TerminateTaskResult,
} from "../../orchestration/task-terminator.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { StepProgressReporter } from "../output/step-progress.js";
import { isEctlError } from "../../types/errors.js";

export interface TerminateCommandOptions {
  readonly name?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: TerminateCommandOptions,
  root: TerminateCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function createTerminateProgress(
  reporter: StepProgressReporter,
): TerminateProgress {
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

function printTerminateSuccess(result: TerminateTaskResult): void {
  if (result.alreadyTerminated) {
    console.log(
      chalk.blue(`Task '${result.taskName}' is already terminated.`),
    );
    console.log(chalk.dim("Next: `ectl launch` or `ectl deploy` to start a new task."));
    console.log("");
    return;
  }

  console.log("");
  console.log(
    chalk.green.bold(`Task '${result.taskName}' terminated and cleaned up.`),
  );
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId || chalk.dim("(none)")}`);
  console.log(
    `  ${chalk.dim("Security group")} ${result.securityGroupId || chalk.dim("(none)")}`,
  );
  console.log(`  ${chalk.dim("Status")}        ${chalk.green(result.status)}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim(
      "Key pair preserved in `.ectl/keys/` for the next launch.",
    ),
  );
  console.log(chalk.dim("Next: `ectl launch` or `ectl deploy` to start a new task."));
  console.log("");
}

export async function runTerminateCommand(
  options: TerminateCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Terminating task${options.name !== undefined ? ` '${options.name}'` : ""}`,
  );

  if (ctx.json === false) {
    const confirmed = await confirm({
      message:
        "Terminate the EC2 instance and delete its security group? This cannot be undone.",
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim("Terminate cancelled."));
      return;
    }
  }

  const terminator = createTaskTerminator();
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      "ectl terminate — tear down",
      "Terminates the EC2 instance, deletes the security group, and updates local state.",
    );
  }

  try {
    const result = await terminator.terminate(
      options.name !== undefined ? { taskName: options.name } : {},
      reporter ? createTerminateProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("terminate", result));
      return;
    }

    printTerminateSuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerTerminateCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("terminate")
    .description("Terminate the EC2 instance and delete its security group")
    .option("--name <task>", "Task name (default: active task)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<TerminateCommandOptions>();
      const root = this.parent?.opts<TerminateCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runTerminateCommand(local, ctx);
      } catch (error) {
        if (ctx.json) {
          printJson(envelopeFromError("terminate", error));
        } else if (isEctlError(error)) {
          console.error(chalk.red(error.message));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(message));
        }
        process.exit(1);
      }
    });
}
