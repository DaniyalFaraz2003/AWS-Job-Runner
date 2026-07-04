import type { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  isNoActiveTaskResult,
  type TaskStatusSnapshot,
} from "../../orchestration/task-status.js";
import {
  createSuccessEnvelope,
  printJson,
} from "../output/envelope.js";
import { handleCommandError } from "../output/command-error.js";
import { createStatusCheckerForContext } from "../service-deps.js";
import type { TaskStatus } from "../../types/state.js";

export interface StatusCommandOptions {
  readonly name?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: StatusCommandOptions,
  root: StatusCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function formatTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "running":
      return chalk.green(status);
    case "provisioning":
      return chalk.yellow(status);
    case "failed":
      return chalk.red(status);
    case "stopped":
      return chalk.blue(status);
    case "terminated":
    case "completed":
      return chalk.dim(status);
    default:
      return status;
  }
}

function formatPm2Status(snapshot: TaskStatusSnapshot): string {
  if (snapshot.pm2 !== null) {
    const pid =
      snapshot.pm2.pid !== null ? String(snapshot.pm2.pid) : "n/a";
    return `${snapshot.pm2.status} (pid ${pid})`;
  }

  if (snapshot.pm2Unreachable) {
    return chalk.yellow("unreachable");
  }

  return chalk.dim("n/a");
}

function printNoActiveTask(): void {
  console.log(chalk.dim("No active task."));
}

function printStatusTable(snapshot: TaskStatusSnapshot): void {
  const table = new Table({
    head: [chalk.dim("Field"), chalk.dim("Value")],
    style: { head: [], border: [] },
  });

  const { state, run, reconciliation } = snapshot;

  table.push(
    ["Task", snapshot.taskName],
    ["Status", formatTaskStatus(state.status)],
    ["Instance", state.instanceId || chalk.dim("n/a")],
    ["Public IP", state.publicIp || chalk.dim("n/a")],
    ["Security group", state.securityGroupId || chalk.dim("n/a")],
    ["Region", state.region],
    [
      "AWS instance",
      reconciliation.awsInstanceState ?? chalk.dim("n/a"),
    ],
    ["pm2", formatPm2Status(snapshot)],
  );

  if (run !== null) {
    table.push(
      ["Run command", run.command],
      ["Run source", run.source],
      ["Started", run.startedAt],
    );
  }

  if (state.lastReconciledAt !== undefined) {
    table.push(["Last reconciled", state.lastReconciledAt]);
  }

  console.log("");
  console.log(table.toString());

  for (const warning of reconciliation.warnings) {
    console.log(chalk.yellow(`Warning: ${warning}`));
  }

  if (reconciliation.publicIpChanged) {
    console.log(
      chalk.yellow(
        "Public IP changed since last run — local state was updated.",
      ),
    );
  }

  console.log("");
}

export async function runStatusCommand(
  options: StatusCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Checking task status${options.name !== undefined ? ` for '${options.name}'` : ""}`,
  );

  const checker = createStatusCheckerForContext(ctx);
  const spinner =
    ctx.json === false ? ora("Reconciling with AWS…").start() : null;

  try {
    const result = await checker.status(
      options.name !== undefined ? { taskName: options.name } : {},
    );

    spinner?.stop();

    if (isNoActiveTaskResult(result)) {
      if (ctx.json) {
        printJson(createSuccessEnvelope("status", result));
        return;
      }

      printNoActiveTask();
      return;
    }

    if (ctx.json) {
      printJson(createSuccessEnvelope("status", result));
      return;
    }

    printStatusTable(result);
  } catch (error) {
    spinner?.fail("Reconciliation failed");
    throw error;
  }
}

export function registerStatusCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("status")
    .description("Show task state and reconcile with AWS")
    .option("--name <task>", "Task name (default: active task)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<StatusCommandOptions>();
      const root = this.parent?.opts<StatusCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runStatusCommand(local, ctx);
      } catch (error) {
        handleCommandError(ctx, "status", error);
      }
    });
}
