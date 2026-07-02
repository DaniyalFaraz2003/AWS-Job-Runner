import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerStubCommand } from "./stub.js";

export function registerDeployCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  registerStubCommand(
    program,
    getContext,
    "deploy",
    "Launch, push, and run in one step",
  );
}
