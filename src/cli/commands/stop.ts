import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskStopper,
  type StopTaskResult,
} from "../../orchestration/task-stopper.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { isEctlError } from "../../types/errors.js";

export interface StopCommandOptions {
  readonly name?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: StopCommandOptions,
  root: StopCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function printStopSuccess(result: StopTaskResult): void {
  if (result.alreadyStopped) {
    console.log(
      chalk.blue(
        `Task '${result.taskName}' is already stopped (instance still running).`,
      ),
    );
    console.log(
      chalk.dim("Next: `ectl run` to restart the process, or `ectl terminate` to tear down."),
    );
    console.log("");
    return;
  }

  console.log("");
  console.log(
    chalk.blue.bold(`Process stopped for task '${result.taskName}'.`),
  );
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${result.publicIp}`);
  console.log(`  ${chalk.dim("Status")}        ${chalk.blue(result.status)}`);
  console.log(`  ${chalk.dim("pm2 name")}      ${result.processName}`);
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim(
      "Next: `ectl run` to restart, `ectl status`, or `ectl terminate` when done.",
    ),
  );
  console.log("");
}

export async function runStopCommand(
  options: StopCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Stopping task${options.name !== undefined ? ` '${options.name}'` : ""}`,
  );

  const stopper = createTaskStopper();
  const spinner = ctx.json === false ? ora("Stopping pm2 process…").start() : null;

  try {
    const result = await stopper.stop(
      options.name !== undefined ? { taskName: options.name } : {},
      {
        onConnecting(host) {
          if (spinner !== null) {
            spinner.text = `Connecting to ${host}…`;
          }
        },
      },
    );

    if (result.alreadyStopped) {
      spinner?.stop();

      if (ctx.json) {
        printJson(createSuccessEnvelope("stop", result));
        return;
      }

      printStopSuccess(result);
      return;
    }

    spinner?.succeed(`Stopped pm2 process '${result.processName}'`);

    if (ctx.json) {
      printJson(createSuccessEnvelope("stop", result));
      return;
    }

    printStopSuccess(result);
  } catch (error) {
    spinner?.fail("Stop failed");
    throw error;
  }
}

export function registerStopCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("stop")
    .description("Stop the pm2 process but keep the EC2 instance running")
    .option("--name <task>", "Task name (default: active task)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<StopCommandOptions>();
      const root = this.parent?.opts<StopCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runStopCommand(local, ctx);
      } catch (error) {
        if (ctx.json) {
          printJson(envelopeFromError("stop", error));
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
