import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerStubCommand } from "./stub.js";

export function registerRunCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  registerStubCommand(
    program,
    getContext,
    "run",
    "Bootstrap the remote environment and start the task under pm2",
  );
}
