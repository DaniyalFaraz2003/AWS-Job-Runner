import { beforeEach, describe, expect, it, vi } from "vitest";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";
import type {
  ExecCommandOptions,
  ExecCommandResult,
  GetFileOptions,
  PutFileOptions,
  SshClient,
  SshConnectConfig,
} from "../../src/ssh/node-ssh-client.js";
import { SshManager } from "../../src/ssh/ssh-manager.js";

class MockSshClient implements SshClient {
  connectFailuresBeforeSuccess = 0;
  connected = false;
  disposed = false;
  lastConnectConfig: SshConnectConfig | null = null;
  execCommandResult: ExecCommandResult = {
    stdout: "ok",
    stderr: "",
    code: 0,
    signal: null,
  };
  openShellCalls = 0;
  private readonly onConnectAttempt: () => number;

  constructor(onConnectAttempt: () => number) {
    this.onConnectAttempt = onConnectAttempt;
  }

  async connect(config: SshConnectConfig): Promise<void> {
    this.lastConnectConfig = config;
    const attempt = this.onConnectAttempt();

    if (attempt <= this.connectFailuresBeforeSuccess) {
      throw new Error("connection refused");
    }

    this.connected = true;
    this.disposed = false;
  }

  isConnected(): boolean {
    return this.connected && !this.disposed;
  }

  async execCommand(
    _command: string,
    _options?: ExecCommandOptions,
  ): Promise<ExecCommandResult> {
    return this.execCommandResult;
  }

  async putFile(
    _localPath: string,
    _remotePath: string,
    _options?: PutFileOptions,
  ): Promise<void> {
    return;
  }

  async getFile(
    _remotePath: string,
    _localPath: string,
    _options?: GetFileOptions,
  ): Promise<void> {
    return;
  }

  async getDirectory(
    _remotePath: string,
    _localPath: string,
    _options?: GetFileOptions,
  ): Promise<void> {
    return;
  }

  async openShell(): Promise<void> {
    this.openShellCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.connected = false;
  }
}

describe("SshManager.connect", () => {
  let sleepFn: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  let totalConnectCalls: number;
  let connectFailuresBeforeSuccess: number;

  beforeEach(() => {
    totalConnectCalls = 0;
    connectFailuresBeforeSuccess = 0;
    sleepFn = vi.fn(async (_ms: number) => undefined);
  });

  function createManager(maxAttempts = 3): SshManager {
    return new SshManager({
      createClient: () => {
        const client = new MockSshClient(() => {
          totalConnectCalls += 1;
          return totalConnectCalls;
        });
        client.connectFailuresBeforeSuccess = connectFailuresBeforeSuccess;
        return client;
      },
      retryPolicy: {
        maxAttempts,
        initialDelayMs: 100,
        maxDelayMs: 400,
      },
      sleepFn,
    });
  }

  it("connects on first attempt", async () => {
    const manager = createManager(3);

    await manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    expect(totalConnectCalls).toBe(1);
    expect(manager.connected).toBe(true);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries with exponential backoff before succeeding", async () => {
    connectFailuresBeforeSuccess = 2;
    const manager = createManager(5);

    await manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    expect(totalConnectCalls).toBe(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn.mock.calls[0]?.[0]).toBe(100);
    expect(sleepFn.mock.calls[1]?.[0]).toBe(200);
    expect(manager.connected).toBe(true);
  });

  it("throws SSH_CONNECTION_FAILED after max attempts", async () => {
    connectFailuresBeforeSuccess = 10;
    const manager = createManager(3);

    await expect(
      manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu"),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
    });

    expect(totalConnectCalls).toBe(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("passes optional port to the client", async () => {
    let capturedClient: MockSshClient | null = null;

    const manager = new SshManager({
      createClient: () => {
        capturedClient = new MockSshClient(() => 1);
        return capturedClient;
      },
      retryPolicy: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 100 },
      sleepFn,
    });

    await manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu", {
      port: 2222,
    });

    expect(capturedClient?.lastConnectConfig?.port).toBe(2222);
  });
});

describe("SshManager operations", () => {
  let mockClient: MockSshClient;
  let manager: SshManager;

  beforeEach(async () => {
    mockClient = new MockSshClient(() => 1);
    manager = new SshManager({
      createClient: () => mockClient,
      retryPolicy: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 100 },
    });
    await manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");
  });

  it("execCommand returns stdout/stderr/code", async () => {
    mockClient.execCommandResult = {
      stdout: "hello",
      stderr: "warn",
      code: 0,
      signal: null,
    };

    await expect(manager.execCommand("echo hello")).resolves.toEqual({
      stdout: "hello",
      stderr: "warn",
      code: 0,
      signal: null,
    });
  });

  it("openShell delegates to the client", async () => {
    await manager.openShell();
    expect(mockClient.openShellCalls).toBe(1);
  });

  it("requires a connected client for execCommand", async () => {
    manager.dispose();

    await expect(manager.execCommand("echo hi")).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
    });
  });

  it("dispose cleans up the underlying client", async () => {
    manager.dispose();

    expect(mockClient.disposed).toBe(true);
    expect(manager.connected).toBe(false);
  });

  it("reconnect disposes the previous client", async () => {
    const firstClient = mockClient;
    const secondClient = new MockSshClient(() => 1);

    let created = 0;
    manager = new SshManager({
      createClient: () => {
        created += 1;
        return created === 1 ? firstClient : secondClient;
      },
      retryPolicy: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 100 },
    });

    await manager.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");
    await manager.connect("203.0.113.11", "/tmp/key.pem", "ubuntu");

    expect(firstClient.disposed).toBe(true);
    expect(secondClient.connected).toBe(true);
    expect(secondClient.lastConnectConfig?.host).toBe("203.0.113.11");
  });
});
