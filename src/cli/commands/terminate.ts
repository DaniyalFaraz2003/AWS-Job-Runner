import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerStubCommand } from "./stub.js";

export function registerTerminateCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  registerStubCommand(
    program,
    getContext,
    "terminate",
    "Terminate the EC2 instance and delete its security group",
  );
}
