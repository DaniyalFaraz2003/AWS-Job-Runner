import type { Command } from "commander";
import chalk from "chalk";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createTaskPuller,
  type PullProgress,
  type PullTaskResult,
} from "../../orchestration/task-puller.js";
import {
  createSuccessEnvelope,
  printJson,
} from "../output/envelope.js";
import { handleCommandError } from "../output/command-error.js";
import { StepProgressReporter } from "../output/step-progress.js";

export interface PullCommandOptions {
  readonly name?: string;
  readonly output?: string;
  readonly paths?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function resolveContext(
  getContext: () => CliContext,
  local: PullCommandOptions,
  root: PullCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

function createPullProgress(reporter: StepProgressReporter): PullProgress {
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

function printPullSuccess(result: PullTaskResult): void {
  console.log("");
  console.log(
    chalk.green.bold(`Artifacts downloaded for task '${result.taskName}'.`),
  );
  console.log(chalk.dim("─".repeat(48)));
  console.log(`  ${chalk.dim("Instance")}      ${result.instanceId}`);
  console.log(`  ${chalk.dim("Public IP")}     ${result.publicIp}`);
  console.log(`  ${chalk.dim("Destination")}   ${result.localDest}`);
  console.log(`  ${chalk.dim("Files")}         ${String(result.artifacts.length)}`);
  for (const artifact of result.artifacts) {
    console.log(`    ${chalk.dim("·")} ${artifact.artifactPath} → ${artifact.localPath}`);
  }
  console.log(chalk.dim("─".repeat(48)));
  console.log(
    chalk.dim("Next: `ectl terminate` when you are done with the instance."),
  );
  console.log("");
}

export async function runPullCommand(
  options: PullCommandOptions,
  ctx: CliContext,
): Promise<void> {
  logVerbose(
    ctx,
    `Pulling artifacts${options.name !== undefined ? ` for task '${options.name}'` : ""}`,
  );

  const puller = createTaskPuller();
  const reporter = ctx.json ? null : new StepProgressReporter();

  if (reporter !== null) {
    reporter.printHeader(
      "ectl pull — download artifacts",
      "Downloads configured remote paths to `.ectl/logs/<task>/` (or `--output`).",
    );
  }

  try {
    const result = await puller.pull(
      {
        ...(options.name !== undefined ? { taskName: options.name } : {}),
        ...(options.output !== undefined ? { output: options.output } : {}),
        ...(options.paths !== undefined ? { paths: options.paths } : {}),
      },
      reporter ? createPullProgress(reporter) : undefined,
    );

    if (ctx.json) {
      printJson(createSuccessEnvelope("pull", result));
      return;
    }

    printPullSuccess(result);
  } catch (error) {
    reporter?.stop();
    throw error;
  }
}

export function registerPullCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("pull")
    .description("Download configured artifact paths from the remote instance")
    .option("--name <task>", "Task name (default: active task)")
    .option("--output <path>", "Override local destination directory")
    .option(
      "--paths <paths>",
      "Comma-separated remote paths (overrides config artifactPaths)",
    )
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<PullCommandOptions>();
      const root = this.parent?.opts<PullCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runPullCommand(local, ctx);
      } catch (error) {
        handleCommandError(ctx, "pull", error);
      }
    });
}
