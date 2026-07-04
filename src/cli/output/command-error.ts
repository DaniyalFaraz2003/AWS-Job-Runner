import chalk from "chalk";
import { formatErrorMessage } from "../../types/error-hints.js";
import type { CliContext } from "../context.js";
import { envelopeFromError, printJson } from "./envelope.js";

export function handleCommandError(
  ctx: CliContext,
  command: string,
  error: unknown,
  options?: { printHuman?: (message: string) => void },
): never {
  if (ctx.json) {
    printJson(envelopeFromError(command, error));
  } else {
    const message = formatErrorMessage(error);
    if (options?.printHuman !== undefined) {
      options.printHuman(message);
    } else {
      console.error(chalk.red(message));
    }
  }
  process.exit(1);
}
