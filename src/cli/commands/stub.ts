import { Command } from "commander";
import { createCliContext, type CliContext } from "../context.js";
import { printNotImplemented } from "../output/format.js";

function applySharedOptions(command: Command): void {
  command
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging");
}

export function registerStubCommand(
  program: Command,
  _getContext: () => CliContext,
  name: string,
  description: string,
): void {
  const command = program.command(name).description(description);
  applySharedOptions(command);

  command.action(function (this: Command) {
    const local = this.opts<{ json?: boolean; verbose?: boolean }>();
    const root = this.parent?.opts<{ json?: boolean; verbose?: boolean }>();
    const ctx = createCliContext({
      json: local.json ?? root?.json ?? false,
      verbose: local.verbose ?? root?.verbose ?? false,
    });
    printNotImplemented(ctx, name);
  });
}
