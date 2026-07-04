import type { Command } from "commander";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import { createTaskSshSession } from "../../orchestration/task-ssh.js";
import { handleCommandError } from "../output/command-error.js";
import { isEctlError, ECTL_ERROR_CODES, EctlError } from "../../types/errors.js";

export interface SshCommandOptions {
  readonly name?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: SshCommandOptions,
  root: SshCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

export async function runSshCommand(
  options: SshCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Opening SSH session${options.name !== undefined ? ` for '${options.name}'` : ""}`,
  );

  if (ctx.json) {
    throw new EctlError(
      ECTL_ERROR_CODES.STATE_INVALID,
      "Interactive SSH does not support `--json` output.",
    );
  }

  const session = createTaskSshSession();
  await session.open(
    options.name !== undefined ? { taskName: options.name } : {},
    {
      onConnecting(host) {
        console.log(chalk.dim(`Connecting to ${host}…`));
      },
      onConnected(host) {
        console.log(chalk.dim(`Opening shell on ${host} (Ctrl+D to exit).`));
        console.log("");
      },
    },
  );
}

export function registerSshCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("ssh")
    .description("Open an interactive shell on the task instance")
    .option("--name <task>", "Task name (default: active task)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<SshCommandOptions>();
      const root = this.parent?.opts<SshCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runSshCommand(local, ctx);
      } catch (error) {
        handleCommandError(ctx, "ssh", error);
      }
    });
}
