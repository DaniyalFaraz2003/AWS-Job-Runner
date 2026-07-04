import type { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskLauncher,
  type LaunchTaskResult,
} from "../../orchestration/task-launcher.js";
import { resolveTaskName } from "../../state/task-name.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { isEctlError } from "../../types/errors.js";

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

function printLaunchSuccess(result: LaunchTaskResult): void {
  const { taskName, state } = result;
  console.log(chalk.green(`Task '${taskName}' launched successfully.`));
  console.log(`  Instance:  ${state.instanceId}`);
  console.log(`  Public IP: ${state.publicIp}`);
  console.log(`  Status:    ${state.status}`);
  console.log(
    chalk.dim("\nNext: `ectl push` to upload your project, then `ectl run`."),
  );
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

  const launcher = createTaskLauncher();
  let spinner: ReturnType<typeof ora> | undefined;

  if (!ctx.json) {
    spinner = ora("Launching EC2 instance…").start();
  }

  try {
    const result = await launcher.launch(
      {
        taskName,
        allowAnyIp,
      },
      spinner
        ? {
            update(message: string) {
              spinner!.text = message;
            },
          }
        : undefined,
    );

    if (spinner !== undefined) {
      spinner.succeed(`Task '${taskName}' is running`);
    }

    if (ctx.json) {
      printJson(createSuccessEnvelope("launch", result));
      return;
    }

    printLaunchSuccess(result);
  } catch (error) {
    if (spinner !== undefined) {
      spinner.fail("Launch failed");
    }
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
        if (ctx.json) {
          printJson(envelopeFromError("launch", error));
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
