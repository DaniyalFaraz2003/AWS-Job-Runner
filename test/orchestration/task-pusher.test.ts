import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskPusher } from "../../src/orchestration/task-pusher.js";
import type { BootstrapScript } from "../../src/process/bootstrap-script.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
import type { TransferManager } from "../../src/transfer/transfer-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";
import type { EctlConfig } from "../../src/types/config.js";
import type { TaskState } from "../../src/types/state.js";

const config: EctlConfig = {
  version: 1,
  region: "us-east-1",
  instanceType: "t3.medium",
  amiId: "ami-ubuntu2204",
  sshUser: "ubuntu",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
  keyPairName: "ectl-demo-key",
  keySource: "generated",
  artifactPaths: [],
  projectSlug: "demo",
  tags: {},
};

const runningState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-pushable",
  publicIp: "203.0.113.20",
  securityGroupId: "sg-pushable",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T12:00:00.000Z",
  updatedAt: "2026-07-04T12:00:00.000Z",
};

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-push-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function createMockStateStore(overrides: Partial<StateStore> = {}): StateStore {
  return {
    assertActiveTask: vi.fn(async () => ({
      taskName: "default",
      state: runningState,
    })),
    readState: vi.fn(async () => runningState),
    assertNoActiveTask: vi.fn(),
    writeState: vi.fn(),
    readRun: vi.fn(),
    writeRun: vi.fn(),
    getActiveTask: vi.fn(),
    listTaskNames: vi.fn(),
    tasksDir: "",
    taskDir: vi.fn(),
    statePath: vi.fn(),
    runPath: vi.fn(),
    ...overrides,
  } as unknown as StateStore;
}

function createMockSshManager(): SshManager {
  return {
    connect: vi.fn(async () => undefined),
    dispose: vi.fn(),
    execCommand: vi.fn(),
    putFile: vi.fn(),
    getFile: vi.fn(),
    getDirectory: vi.fn(),
    openShell: vi.fn(),
    connected: false,
  } as unknown as SshManager;
}

function createMockBootstrapScript(
  ensureBasePackages = vi.fn(async () => undefined),
): BootstrapScript {
  return {
    ensureBasePackages,
    ensureReady: vi.fn(),
  } as unknown as BootstrapScript;
}

function createMockTransferManager(): TransferManager {
  return {
    pushProject: vi.fn(async () => undefined),
    pullArtifacts: vi.fn(),
  } as unknown as TransferManager;
}

describe("TaskPusher", () => {
  it("rejects tasks that are not running or stopped", async () => {
    const root = await createProjectRoot();
    const provisioningState: TaskState = {
      ...runningState,
      status: "provisioning",
    };

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: provisioningState,
          })),
        }),
    });

    await expect(pusher.push({ projectRoot: root })).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NO_ACTIVE_TASK,
    });
  });

  it("rejects tasks without a public IP", async () => {
    const root = await createProjectRoot();
    const noIpState: TaskState = {
      ...runningState,
      publicIp: "",
    };

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: noIpState,
          })),
        }),
    });

    await expect(pusher.push({ projectRoot: root })).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
    });
  });

  it("rejects unknown named tasks", async () => {
    const root = await createProjectRoot();

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          readState: vi.fn(async () => null),
        }),
    });

    await expect(
      pusher.push({ projectRoot: root, taskName: "missing" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NO_ACTIVE_TASK,
    });
  });

  it("uploads project via SSH and TransferManager", async () => {
    const root = await createProjectRoot();
    const ssh = createMockSshManager();
    const transferManager = createMockTransferManager();
    const ensureBasePackages = vi.fn(async () => undefined);

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
      createSshManager: () => ssh,
      createBootstrapScript: () =>
        createMockBootstrapScript(ensureBasePackages),
      createTransferManager: () => transferManager,
    });

    const result = await pusher.push({ projectRoot: root });

    expect(ensureBasePackages).toHaveBeenCalledOnce();
    expect(ssh.connect).toHaveBeenCalledWith(
      "203.0.113.20",
      join(root, ".ectl", "keys", "ectl-key.pem"),
      "ubuntu",
      expect.objectContaining({
        onRetry: expect.any(Function),
      }),
    );
    expect(transferManager.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: root,
        remoteWorkDir: "/home/ubuntu/ectl-workspace",
      }),
    );
    expect(ssh.dispose).toHaveBeenCalled();

    expect(result).toEqual({
      taskName: "default",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      publicIp: "203.0.113.20",
      instanceId: "i-pushable",
    });
  });

  it("allows push for stopped tasks", async () => {
    const root = await createProjectRoot();
    const stoppedState: TaskState = {
      ...runningState,
      status: "stopped",
    };
    const transferManager = createMockTransferManager();

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: stoppedState,
          })),
        }),
      createSshManager: () => createMockSshManager(),
      createBootstrapScript: () => createMockBootstrapScript(),
      createTransferManager: () => transferManager,
    });

    const result = await pusher.push({ projectRoot: root });

    expect(result.taskName).toBe("default");
    expect(transferManager.pushProject).toHaveBeenCalledOnce();
  });

  it("reads named task state when --name is provided", async () => {
    const root = await createProjectRoot();
    const readState = vi.fn(async () => runningState);
    const transferManager = createMockTransferManager();

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          readState,
          assertActiveTask: vi.fn(async () => {
            throw new EctlError(
              ECTL_ERROR_CODES.NO_ACTIVE_TASK,
              "should not be called",
            );
          }),
        }),
      createSshManager: () => createMockSshManager(),
      createBootstrapScript: () => createMockBootstrapScript(),
      createTransferManager: () => transferManager,
    });

    await pusher.push({ projectRoot: root, taskName: "default" });

    expect(readState).toHaveBeenCalledWith("default");
    expect(transferManager.pushProject).toHaveBeenCalledOnce();
  });

  it("throws when private key is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-push-nokey-"));
    await mkdir(join(root, ".ectl"), { recursive: true });
    await writeFile(
      join(root, ".ectl", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );

    const pusher = new TaskPusher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
    });

    await expect(pusher.push({ projectRoot: root })).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NOT_INITIALIZED,
    });
  });
});
