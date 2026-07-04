import { existsSync } from "node:fs";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createProcessManager,
  type ProcessManager,
} from "../process/process-manager.js";
import {
  createStateStore,
  type StateStore,
} from "../state/state-store.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { resolveReachableTask } from "./resolve-reachable-task.js";

export interface LogsTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
  readonly lines?: number;
  readonly follow?: boolean;
}

export interface LogsTaskResult {
  readonly taskName: string;
  readonly processName: string;
  readonly output: string;
  readonly followed: boolean;
  readonly lines: number;
}

export interface LogsProgress {
  onConnecting?(host: string): void;
  onConnected?(processName: string): void;
}

export interface TaskLogsFetcherDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
  readonly createProcessManager?: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;
}

export class TaskLogsFetcher {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;
  private readonly createProcessManagerFn: (
    ssh: SshManager,
    stateStore: StateStore,
  ) => ProcessManager;

  constructor(deps: TaskLogsFetcherDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
    this.createProcessManagerFn =
      deps.createProcessManager ??
      ((ssh, stateStore) => createProcessManager({ ssh, stateStore }));
  }

  async fetch(
    input: LogsTaskInput,
    progress?: LogsProgress,
  ): Promise<LogsTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());
    const lines = input.lines ?? 100;
    const follow = input.follow ?? false;

    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();

    const { taskName, state } = await resolveReachableTask(
      stateStore,
      input.taskName,
    );

    const run = await stateStore.readRun(taskName);
    const processName = run?.pm2ProcessName ?? taskName;

    const keyPath = getPrivateKeyPath(projectRoot);
    if (!existsSync(keyPath)) {
      throw new EctlError(
        ECTL_ERROR_CODES.NOT_INITIALIZED,
        `Private key not found at ${keyPath}. Run \`ectl init\` first.`,
      );
    }

    const host = `${config.sshUser}@${state.publicIp}`;
    progress?.onConnecting?.(host);

    const ssh = this.createSshManagerFn();
    try {
      await ssh.connect(state.publicIp, keyPath, config.sshUser);
      progress?.onConnected?.(processName);

      const processManager = this.createProcessManagerFn(ssh, stateStore);

      if (follow) {
        await this.streamFollowLogs(processManager, processName, lines);
        return {
          taskName,
          processName,
          output: "",
          followed: true,
          lines,
        };
      }

      const output = await processManager.getLogs(processName, { lines });
      return {
        taskName,
        processName,
        output,
        followed: false,
        lines,
      };
    } finally {
      ssh.dispose();
    }
  }

  private async streamFollowLogs(
    processManager: ProcessManager,
    processName: string,
    lines: number,
  ): Promise<void> {
    const command = processManager.buildFollowLogsCommand(processName, { lines });
    const abortController = new AbortController();

    const onSigInt = (): void => {
      abortController.abort();
    };

    process.on("SIGINT", onSigInt);

    try {
      await processManager.streamLogs(command, {
        signal: abortController.signal,
        onStdout: (chunk) => {
          process.stdout.write(chunk);
        },
        onStderr: (chunk) => {
          process.stderr.write(chunk);
        },
      });
    } finally {
      process.off("SIGINT", onSigInt);
    }
  }
}

export function createTaskLogsFetcher(
  deps: TaskLogsFetcherDeps = {},
): TaskLogsFetcher {
  return new TaskLogsFetcher(deps);
}
