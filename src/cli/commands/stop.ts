import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerStubCommand } from "./stub.js";

export function registerStopCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  registerStubCommand(
    program,
    getContext,
    "stop",
    "Stop the pm2 process but keep the EC2 instance running",
  );
}
