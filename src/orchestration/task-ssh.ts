import { existsSync } from "node:fs";
import {
  createConfigManager,
  type ConfigManager,
} from "../config/config-manager.js";
import { getPrivateKeyPath, requireProjectRoot } from "../config/paths.js";
import {
  createStateStore,
  type StateStore,
} from "../state/state-store.js";
import { createSshManager, type SshManager } from "../ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { resolveReachableTask } from "./resolve-reachable-task.js";

export interface SshTaskInput {
  readonly projectRoot?: string;
  readonly taskName?: string;
}

export interface SshTaskResult {
  readonly taskName: string;
  readonly host: string;
  readonly publicIp: string;
  readonly instanceId: string;
}

export interface SshProgress {
  onConnecting?(host: string): void;
  onConnected?(host: string): void;
}

export interface TaskSshSessionDeps {
  readonly createConfigManager?: (projectRoot: string) => ConfigManager;
  readonly createStateStore?: (projectRoot: string) => StateStore;
  readonly createSshManager?: () => SshManager;
}

export class TaskSshSession {
  private readonly createConfigManagerFn: (projectRoot: string) => ConfigManager;
  private readonly createStateStoreFn: (projectRoot: string) => StateStore;
  private readonly createSshManagerFn: () => SshManager;

  constructor(deps: TaskSshSessionDeps = {}) {
    this.createConfigManagerFn =
      deps.createConfigManager ?? createConfigManager;
    this.createStateStoreFn = deps.createStateStore ?? createStateStore;
    this.createSshManagerFn = deps.createSshManager ?? createSshManager;
  }

  /** Connect and open an interactive shell (FR-SSH-1–3). Session ends when the shell closes. */
  async open(
    input: SshTaskInput,
    progress?: SshProgress,
  ): Promise<SshTaskResult> {
    const projectRoot = input.projectRoot ?? requireProjectRoot(process.cwd());

    const configManager = this.createConfigManagerFn(projectRoot);
    const stateStore = this.createStateStoreFn(projectRoot);
    const config = await configManager.read();

    const { taskName, state } = await resolveReachableTask(
      stateStore,
      input.taskName,
    );

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
      progress?.onConnected?.(host);
      await ssh.openShell();
    } finally {
      ssh.dispose();
    }

    return {
      taskName,
      host,
      publicIp: state.publicIp,
      instanceId: state.instanceId,
    };
  }
}

export function createTaskSshSession(
  deps: TaskSshSessionDeps = {},
): TaskSshSession {
  return new TaskSshSession(deps);
}
