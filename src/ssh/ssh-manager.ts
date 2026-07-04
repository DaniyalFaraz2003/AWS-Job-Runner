import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import {
  createNodeSshClient,
  type ExecCommandOptions,
  type ExecCommandResult,
  type SshClient,
} from "./node-ssh-client.js";
import {
  computeRetryDelayMs,
  DEFAULT_SSH_RETRY_POLICY,
  sleep,
  type RetryPolicyOptions,
} from "./retry-policy.js";

export interface SshManagerDeps {
  readonly createClient?: () => SshClient;
  readonly retryPolicy?: RetryPolicyOptions;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export class SshManager {
  private client: SshClient | null = null;
  private readonly createClient: () => SshClient;
  private readonly retryPolicy: RetryPolicyOptions;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(deps: SshManagerDeps = {}) {
    this.createClient = deps.createClient ?? createNodeSshClient;
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_SSH_RETRY_POLICY;
    this.sleepFn = deps.sleepFn ?? sleep;
  }

  get connected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /** Connect with exponential backoff (FR-LAUNCH-9, NFR-3). */
  async connect(
    host: string,
    keyPath: string,
    user: string,
    options: { port?: number } = {},
  ): Promise<void> {
    this.dispose();

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      const client = this.createClient();

      try {
        const connectConfig: Parameters<SshClient["connect"]>[0] =
          options.port !== undefined
            ? {
                host,
                username: user,
                privateKeyPath: keyPath,
                port: options.port,
              }
            : {
                host,
                username: user,
                privateKeyPath: keyPath,
              };

        await client.connect(connectConfig);
        this.client = client;
        return;
      } catch (error) {
        lastError = error;
        client.dispose();

        if (attempt >= this.retryPolicy.maxAttempts) {
          break;
        }

        const delayMs = computeRetryDelayMs(attempt, this.retryPolicy);
        await this.sleepFn(delayMs);
      }
    }

    throw new EctlError(
      ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
      `Could not connect to ${user}@${host} after ${String(this.retryPolicy.maxAttempts)} attempts. Check security group rules and public IP, then retry with \`ectl status\` or \`ectl ssh\`.`,
      lastError,
    );
  }

  async execCommand(
    command: string,
    options: ExecCommandOptions = {},
  ): Promise<ExecCommandResult> {
    const client = this.requireConnectedClient();
    try {
      return await client.execCommand(command, options);
    } catch (error) {
      throw wrapSshOperationError(error, "Remote command failed");
    }
  }

  async openShell(): Promise<void> {
    const client = this.requireConnectedClient();
    try {
      await client.openShell();
    } catch (error) {
      throw wrapSshOperationError(error, "Interactive SSH session failed");
    }
  }

  dispose(): void {
    if (this.client !== null) {
      this.client.dispose();
      this.client = null;
    }
  }

  private requireConnectedClient(): SshClient {
    if (this.client === null || !this.client.isConnected()) {
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        "SSH session is not connected. Run `ectl launch` or `ectl deploy` first.",
      );
    }

    return this.client;
  }
}

export function createSshManager(deps: SshManagerDeps = {}): SshManager {
  return new SshManager(deps);
}

function wrapSshOperationError(error: unknown, message: string): EctlError {
  if (error instanceof EctlError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new EctlError(
    ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
    `${message}: ${detail}. Try \`ectl status\` or \`ectl ssh\`.`,
    error,
  );
}
