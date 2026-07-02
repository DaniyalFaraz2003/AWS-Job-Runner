import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerStubCommand } from "./stub.js";

export function registerPullCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  registerStubCommand(
    program,
    getContext,
    "pull",
    "Download configured artifact paths from the remote instance",
  );
}
