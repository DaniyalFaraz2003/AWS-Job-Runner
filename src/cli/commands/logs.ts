import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskLogsFetcher,
  type LogsTaskResult,
} from "../../orchestration/task-logs.js";
import {
  createSuccessEnvelope,
  printJson,
} from "../output/envelope.js";
import { handleCommandError } from "../output/command-error.js";
import { isEctlError, ECTL_ERROR_CODES, EctlError } from "../../types/errors.js";

export interface LogsCommandOptions {
  readonly lines?: string;
  readonly follow?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: LogsCommandOptions,
  root: LogsCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function parseLines(value: string | undefined): number {
  if (value === undefined) {
    return 100;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new EctlError(
      ECTL_ERROR_CODES.STATE_INVALID,
      "`--lines` must be a positive integer.",
    );
  }

  return parsed;
}

function printLogsOutput(result: LogsTaskResult): void {
  if (result.followed) {
    return;
  }

  if (result.output.length > 0) {
    process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
  }
}

export async function runLogsCommand(
  taskArg: string | undefined,
  options: LogsCommandOptions,
  ctx: CliContext,
): Promise<void> {
  const lines = parseLines(options.lines);
  const follow = options.follow ?? false;

  if (ctx.json && follow) {
    throw new EctlError(
      ECTL_ERROR_CODES.STATE_INVALID,
      "`--json` cannot be used with `--follow`.",
    );
  }

  logVerbose(
    ctx,
    `Fetching logs${taskArg !== undefined ? ` for '${taskArg}'` : ""}${
      follow ? " (follow)" : ""
    }`,
  );

  const fetcher = createTaskLogsFetcher();
  const spinner =
    ctx.json === false && follow === false
      ? ora("Fetching pm2 logs…").start()
      : null;

  try {
    const result = await fetcher.fetch(
      {
        ...(taskArg !== undefined ? { taskName: taskArg } : {}),
        lines,
        follow,
      },
      {
        onConnecting(host) {
          if (follow) {
            console.log(chalk.dim(`Connecting to ${host}…`));
            return;
          }
          if (spinner !== null) {
            spinner.text = `Connecting to ${host}…`;
          }
        },
        onConnected(processName) {
          if (follow) {
            console.log(
              chalk.dim(
                `Streaming logs for '${processName}' (Ctrl+C to stop).`,
              ),
            );
          }
        },
      },
    );

    spinner?.stop();

    if (ctx.json) {
      printJson(createSuccessEnvelope("logs", result));
      return;
    }

    printLogsOutput(result);
  } catch (error) {
    spinner?.fail("Failed to fetch logs");
    throw error;
  }
}

export function registerLogsCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("logs")
    .description("View pm2 logs for a task")
    .argument("[task]", "Task name (default: active task)")
    .option("--lines <n>", "Number of log lines to show", "100")
    .option("-f, --follow", "Stream logs in real time until interrupted")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command, task: string | undefined) {
      const local = this.opts<LogsCommandOptions>();
      const root = this.parent?.opts<LogsCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runLogsCommand(task, local, ctx);
      } catch (error) {
        handleCommandError(ctx, "logs", error);
      }
    });
}
