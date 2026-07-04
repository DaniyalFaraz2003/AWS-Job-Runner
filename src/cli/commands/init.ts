import type { Command } from "commander";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { resolve } from "node:path";
import { formatAmiChoiceLabel } from "../../aws/ami-resolver.js";
import type { CliContext } from "../context.js";
import { logVerbose } from "../context.js";
import {
  createProjectInitializer,
  DEFAULT_INSTANCE_TYPES,
  type InitPrompts,
  type InitResult,
} from "../../config/project-initializer.js";
import {
  createSuccessEnvelope,
  envelopeFromError,
  printJson,
} from "../output/envelope.js";
import { isEctlError } from "../../types/errors.js";

export interface InitCommandOptions {
  readonly region?: string;
  readonly instanceType?: string;
  readonly amiId?: string;
  readonly importKey?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

function createInitPrompts(
  ctx: CliContext,
  options: { skipForceConfirm: boolean; skipAmiPrompt: boolean },
): InitPrompts {
  return {
    async selectRegion(defaultRegion: string): Promise<string> {
      return input({
        message: "AWS region",
        default: defaultRegion,
        validate: (value) =>
          value.trim().length > 0 || "Region is required",
      });
    },

    async selectInstanceType(defaultType: string): Promise<string> {
      const choice = await select({
        message: "EC2 instance type",
        default: defaultType,
        choices: DEFAULT_INSTANCE_TYPES.map((type) => ({
          name: type,
          value: type,
        })),
      });

      return choice;
    },

    async selectAmi(candidates) {
      if (options.skipAmiPrompt) {
        const preferred =
          candidates.find((candidate) => candidate.ubuntuVersion === "24.04") ??
          candidates[0];
        return preferred!.amiId;
      }

      return select({
        message: "Ubuntu LTS AMI (22.04 / 24.04 / 26.04)",
        default: candidates[0]!.amiId,
        choices: candidates.map((candidate) => ({
          name: formatAmiChoiceLabel(candidate),
          value: candidate.amiId,
        })),
        pageSize: Math.min(candidates.length, 12),
      });
    },

    async confirmForce(): Promise<boolean> {
      if (options.skipForceConfirm) {
        return true;
      }

      if (ctx.json) {
        return false;
      }

      return confirm({
        message:
          "Reinitializing will delete the existing .ectl/ directory. Continue?",
        default: false,
      });
    },
  };
}

function printInitSuccess(result: InitResult): void {
  console.log(chalk.green("Initialized ectl project."));
  console.log(`  Project root: ${result.projectRoot}`);
  console.log(`  Region:       ${result.config.region}`);
  console.log(`  Instance:     ${result.config.instanceType}`);
  console.log(`  Key pair:     ${result.config.keyPairName} (${result.keySource})`);
  console.log(`  AMI:          ${result.config.amiId ?? "(none)"}`);
  if (result.createdEctlignore) {
    console.log(chalk.dim("  Created .ectlignore with default patterns."));
  }
  if (result.updatedGitignore) {
    console.log(chalk.dim("  Appended .ectl/ to .gitignore."));
  }
  console.log(chalk.dim("\nNext: add a run command (.ectl/run.sh or --run) and run `ectl deploy`."));
}

function resolveContext(
  getContext: () => CliContext,
  local: InitCommandOptions,
  root: InitCommandOptions | undefined,
): CliContext {
  return {
    json: local.json ?? root?.json ?? getContext().json,
    verbose: local.verbose ?? root?.verbose ?? getContext().verbose,
  };
}

export async function runInitCommand(
  options: InitCommandOptions,
  ctx: CliContext,
): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const skipForceConfirm = (options.force ?? false) && ctx.json;
  const skipAmiPrompt =
    options.amiId !== undefined || ctx.json;

  logVerbose(ctx, `Initializing project at ${projectRoot}`);

  const initializer = createProjectInitializer();
  const prompts = createInitPrompts(ctx, { skipForceConfirm, skipAmiPrompt });

  const result = await initializer.initialize(
    {
      projectRoot,
      ...(options.region !== undefined ? { region: options.region } : {}),
      ...(options.instanceType !== undefined
        ? { instanceType: options.instanceType }
        : {}),
      ...(options.amiId !== undefined ? { amiId: options.amiId } : {}),
      ...(options.importKey !== undefined
        ? { importKeyPath: resolve(options.importKey) }
        : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    },
    prompts,
  );

  if (ctx.json) {
    printJson(createSuccessEnvelope("init", result));
    return;
  }

  printInitSuccess(result);
}

export function registerInitCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command("init")
    .description("Initialize .ectl in the current project directory")
    .option("--region <region>", "AWS region (skips region prompt)")
    .option("--instance-type <type>", "EC2 instance type (skips type prompt)")
    .option("--ami-id <amiId>", "Ubuntu LTS AMI ID (skips AMI prompt)")
    .option("--import-key <path>", "Import an existing PEM key instead of generating")
    .option("--force", "Reinitialize existing .ectl/ (requires confirmation)")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .action(async function (this: Command) {
      const local = this.opts<InitCommandOptions>();
      const root = this.parent?.opts<InitCommandOptions>();
      const ctx = resolveContext(getContext, local, root);

      try {
        await runInitCommand(local, ctx);
      } catch (error) {
        if (ctx.json) {
          printJson(envelopeFromError("init", error));
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
