import type { Command } from "commander";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskRunner,
  type RunProgress,
  type RunTaskResult,
} from "../../orchestration/task-runner.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { StepProgressReporter } from "../output/step-progress.js";
import { isEctlError } from "../../types/errors.js";

export interface RunCommandOptions {
  readonly name?: string;
  readonly run?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: RunCommandOptions,
  root: RunCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function createRunProgress(reporter: StepProgressReporter): RunProgress {
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

function printRunSuccess(result: RunTaskResult): void {
  console.log("");
  console.log(
    chalk.green.bold(`Process started for task '${result.taskName}'.`),
  );
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${result.publicIp}`);
  console.log(`  ${chalk.dim("Status")}        ${chalk.green(result.status)}`);
  console.log(`  ${chalk.dim("Command")}       ${result.run.command}`);
  console.log(`  ${chalk.dim("Source")}        ${result.run.source}`);
  console.log(`  ${chalk.dim("pm2 name")}      ${result.run.pm2ProcessName}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim(
      "Next: `ectl logs default --follow` to stream output, or `ectl status`.",
    ),
  );
  console.log("");
}

export async function runRunCommand(
  options: RunCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Running task${options.name !== undefined ? ` '${options.name}'` : ""}${
      options.run !== undefined ? ` with command: ${options.run}` : ""
    }`,
  );

  const runner = createTaskRunner();
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      "ectl run — start remote process",
      "Bootstraps Node.js and pm2 on the instance, then starts your command under pm2.",
    );
  }

  try {
    const result = await runner.run(
      {
        ...(options.name !== undefined ? { taskName: options.name } : {}),
        ...(options.run !== undefined ? { run: options.run } : {}),
      },
      reporter ? createRunProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("run", result));
      return;
    }

    printRunSuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerRunCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("run")
    .description("Bootstrap the remote environment and start the task under pm2")
    .option("--name <task>", "Task name (default: active task)")
    .option(
      "--run <command>",
      'Shell command to run (overrides .ectl/run.sh if present)',
    )
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<RunCommandOptions>();
      const root = this.parent?.opts<RunCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runRunCommand(local, ctx);
      } catch (error) {
        if (ctx.json) {
          printJson(envelopeFromError("run", error));
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
