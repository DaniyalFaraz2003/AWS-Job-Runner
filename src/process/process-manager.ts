import type { SshManager } from "../ssh/ssh-manager.js";
import type { StateStore } from "../state/state-store.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskRun } from "../types/run.js";
import { BootstrapScript, createBootstrapScript } from "./bootstrap-script.js";
import {
  buildPm2FollowLogsCommand,
  buildPm2JlistCommand,
  buildPm2LogsCommand,
  buildPm2StartCommand,
  buildPm2StopCommand,
  parsePm2Jlist,
  type Pm2ProcessInfo,
} from "./pm2-commands.js";
import type { RunCommandSource } from "./resolve-run-command.js";

export interface ProcessManagerDeps {
  readonly ssh: SshManager;
  readonly stateStore: StateStore;
  readonly bootstrap?: BootstrapScript;
}

export interface StartProcessOptions {
  readonly taskName: string;
  readonly command: string;
  readonly source: RunCommandSource;
  readonly remoteWorkDir: string;
  readonly nodeVersion: string;
}

export interface GetLogsOptions {
  readonly lines?: number;
}

export class ProcessManager {
  private readonly ssh: SshManager;
  private readonly stateStore: StateStore;
  private readonly bootstrap: BootstrapScript;

  constructor(deps: ProcessManagerDeps) {
    this.ssh = deps.ssh;
    this.stateStore = deps.stateStore;
    this.bootstrap = deps.bootstrap ?? createBootstrapScript({ ssh: deps.ssh });
  }

  /** Install remote dependencies when missing, then start pm2 and persist run.json (FR-RUN-2–6). */
  async startProcess(options: StartProcessOptions): Promise<TaskRun> {
    await this.bootstrap.ensureReady(options.nodeVersion);

    const startCommand = buildPm2StartCommand(
      options.taskName,
      options.command,
      options.remoteWorkDir,
    );
    const startResult = await this.ssh.execCommand(startCommand);

    if (startResult.code !== 0) {
      const detail =
        startResult.stderr.trim() || startResult.stdout.trim() || "unknown error";
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        `Failed to start pm2 process "${options.taskName}": ${detail}. Try \`ectl logs ${options.taskName}\` or \`ectl ssh\`.`,
      );
    }

    const run: TaskRun = {
      command: options.command,
      source: options.source,
      pm2ProcessName: options.taskName,
      startedAt: new Date().toISOString(),
      remoteWorkDir: options.remoteWorkDir,
    };

    await this.stateStore.writeRun(options.taskName, run);
    return run;
  }

  /** Stop pm2 process without terminating the EC2 instance (FR-STOP-1). */
  async stopProcess(processName: string): Promise<void> {
    const result = await this.ssh.execCommand(buildPm2StopCommand(processName));

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        detail.length > 0
          ? `Failed to stop pm2 process "${processName}": ${detail}. Try \`ectl status\`.`
          : `Failed to stop pm2 process "${processName}". Try \`ectl status\`.`,
      );
    }
  }

  /** List pm2 processes as structured data (FR-STATUS-4). */
  async listProcesses(): Promise<Pm2ProcessInfo[]> {
    const result = await this.ssh.execCommand(buildPm2JlistCommand());

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        detail.length > 0
          ? `Failed to query pm2 status: ${detail}. Try \`ectl ssh\`.`
          : "Failed to query pm2 status. Try `ectl ssh`.",
      );
    }

    return parsePm2Jlist(result.stdout);
  }

  /** Fetch recent pm2 logs (FR-LOGS-1, FR-LOGS-3). */
  async getLogs(processName: string, options: GetLogsOptions = {}): Promise<string> {
    const result = await this.ssh.execCommand(
      buildPm2LogsCommand(processName, options),
    );

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        detail.length > 0
          ? `Failed to fetch logs for "${processName}": ${detail}. Try \`ectl ssh\`.`
          : `Failed to fetch logs for "${processName}". Try \`ectl ssh\`.`,
      );
    }

    return result.stdout;
  }

  /** Command string for streaming log follow (FR-LOGS-2; used by `ectl logs --follow`). */
  buildFollowLogsCommand(
    processName: string,
    options: GetLogsOptions = {},
  ): string {
    return buildPm2FollowLogsCommand(processName, options);
  }
}

export function createProcessManager(deps: ProcessManagerDeps): ProcessManager {
  return new ProcessManager(deps);
}

export type { Pm2ProcessInfo };
