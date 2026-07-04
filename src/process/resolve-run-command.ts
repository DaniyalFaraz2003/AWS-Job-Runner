import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEctlDir } from "../config/paths.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskRun } from "../types/run.js";

/** Remote-relative path executed from `remoteWorkDir` (SRS §4.7). */
export const RUN_SCRIPT_REMOTE_COMMAND = "bash .ectl/run.sh";

export function getRunScriptPath(projectRoot: string): string {
  return join(getEctlDir(projectRoot), "run.sh");
}

export type RunCommandSource = TaskRun["source"];

export interface ResolvedRunCommand {
  readonly command: string;
  readonly source: RunCommandSource;
}

/**
 * Resolve run command: `--run` flag overrides `.ectl/run.sh` (FR-RUN-1, SRS §4.7).
 */
export function resolveRunCommand(
  runFlag: string | undefined,
  projectRoot: string,
): ResolvedRunCommand {
  if (runFlag !== undefined && runFlag.trim() !== "") {
    return { command: runFlag.trim(), source: "flag" };
  }

  if (existsSync(getRunScriptPath(projectRoot))) {
    return { command: RUN_SCRIPT_REMOTE_COMMAND, source: "run.sh" };
  }

  throw new EctlError(
    ECTL_ERROR_CODES.RUN_COMMAND_MISSING,
    'No run command provided. Pass --run "<cmd>" or create .ectl/run.sh in your project.',
  );
}
