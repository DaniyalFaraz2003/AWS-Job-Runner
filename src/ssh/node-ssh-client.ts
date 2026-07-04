import { NodeSSH } from "node-ssh";

type ShellChannel = Parameters<Parameters<NodeSSH["withShell"]>[0]>[0];

type SftpTransferOptions = {
  step?: TransferProgressCallback;
};

export interface ExecCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SshConnectConfig {
  readonly host: string;
  readonly username: string;
  readonly privateKeyPath: string;
  readonly port?: number;
}

export interface ExecCommandOptions {
  readonly cwd?: string;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface TransferProgressCallback {
  (transferred: number, chunk: number, total: number): void;
}

export interface PutFileOptions {
  readonly onProgress?: TransferProgressCallback;
}

export interface GetFileOptions {
  readonly onProgress?: TransferProgressCallback;
}

/** Injectable SSH client boundary for tests and SshManager. */
export interface SshClient {
  connect(config: SshConnectConfig): Promise<void>;
  isConnected(): boolean;
  execCommand(
    command: string,
    options?: ExecCommandOptions,
  ): Promise<ExecCommandResult>;
  putFile(
    localPath: string,
    remotePath: string,
    options?: PutFileOptions,
  ): Promise<void>;
  getFile(
    remotePath: string,
    localPath: string,
    options?: GetFileOptions,
  ): Promise<void>;
  getDirectory(
    remotePath: string,
    localPath: string,
    options?: GetFileOptions,
  ): Promise<void>;
  openShell(): Promise<void>;
  dispose(): void;
}

export class NodeSshClient implements SshClient {
  private readonly ssh = new NodeSSH();

  async connect(config: SshConnectConfig): Promise<void> {
    const connectConfig: Parameters<NodeSSH["connect"]>[0] = {
      host: config.host,
      username: config.username,
      privateKeyPath: config.privateKeyPath,
    };

    if (config.port !== undefined) {
      connectConfig.port = config.port;
    }

    await this.ssh.connect(connectConfig);
  }

  isConnected(): boolean {
    return this.ssh.isConnected();
  }

  async execCommand(
    command: string,
    options: ExecCommandOptions = {},
  ): Promise<ExecCommandResult> {
    const execOptions: Parameters<NodeSSH["execCommand"]>[1] = {};
    if (options.cwd !== undefined) {
      execOptions.cwd = options.cwd;
    }
    if (options.onStdout !== undefined) {
      execOptions.onStdout = (chunk: Buffer) => {
        options.onStdout?.(chunk.toString());
      };
    }
    if (options.onStderr !== undefined) {
      execOptions.onStderr = (chunk: Buffer) => {
        options.onStderr?.(chunk.toString());
      };
    }

    const result = await this.ssh.execCommand(command, execOptions);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      signal: result.signal,
    };
  }

  async putFile(
    localPath: string,
    remotePath: string,
    options: PutFileOptions = {},
  ): Promise<void> {
    await this.ssh.putFile(
      localPath,
      remotePath,
      null,
      toTransferOptions(options.onProgress),
    );
  }

  async getFile(
    remotePath: string,
    localPath: string,
    options: GetFileOptions = {},
  ): Promise<void> {
    await this.ssh.getFile(
      localPath,
      remotePath,
      null,
      toTransferOptions(options.onProgress),
    );
  }

  async getDirectory(
    remotePath: string,
    localPath: string,
    options: GetFileOptions = {},
  ): Promise<void> {
    const transferOptions = toTransferOptions(options.onProgress);
    await this.ssh.getDirectory(localPath, remotePath, {
      ...(transferOptions !== null ? { transferOptions } : {}),
    });
  }

  async openShell(): Promise<void> {
    await this.ssh.withShell(
      (channel) => attachInteractiveShell(channel),
      {
        term: process.env.TERM ?? "vt100",
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      },
    );
  }

  dispose(): void {
    this.ssh.dispose();
  }
}

export function createNodeSshClient(): SshClient {
  return new NodeSshClient();
}

function toTransferOptions(
  onProgress?: TransferProgressCallback,
): SftpTransferOptions | null {
  if (onProgress === undefined) {
    return null;
  }

  return { step: onProgress };
}

async function attachInteractiveShell(channel: ShellChannel): Promise<void> {
  const stdin = process.stdin;
  const wasRawMode = stdin.isTTY ? stdin.isRaw : false;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.pipe(channel);
  channel.pipe(process.stdout);
  channel.stderr.pipe(process.stderr);

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      channel.removeListener("close", onClose);
      channel.removeListener("error", onError);
      stdin.unpipe(channel);
      channel.unpipe(process.stdout);
      channel.stderr.unpipe(process.stderr);
      if (stdin.isTTY) {
        stdin.setRawMode(wasRawMode);
      }
      stdin.pause();
    };

    const onClose = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    channel.on("close", onClose);
    channel.on("error", onError);
  });
}
