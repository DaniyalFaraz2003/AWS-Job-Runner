import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskRunner } from "../../src/orchestration/task-runner.js";
import type { ProcessManager } from "../../src/process/process-manager.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";
import type { EctlConfig } from "../../src/types/config.js";
import type { TaskRun } from "../../src/types/run.js";
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
  nodeVersion: "22",
  artifactPaths: [],
  projectSlug: "demo",
  tags: {},
};

const runningState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-runnable",
  publicIp: "203.0.113.30",
  securityGroupId: "sg-runnable",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T12:00:00.000Z",
  updatedAt: "2026-07-04T12:00:00.000Z",
};

const persistedRun: TaskRun = {
  command: "npm start",
  source: "flag",
  pm2ProcessName: "default",
  startedAt: "2026-07-04T13:00:00.000Z",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
};

async function createProjectRoot(options?: {
  includeRunScript?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-run-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  if (options?.includeRunScript === true) {
    await writeFile(join(root, ".ectl", "run.sh"), "#!/bin/bash\nnpm start\n", "utf8");
  }
  return root;
}

function createMockStateStore(overrides: Partial<StateStore> = {}): StateStore {
  return {
    assertActiveTask: vi.fn(async () => ({
      taskName: "default",
      state: runningState,
    })),
    readState: vi.fn(async () => runningState),
    writeState: vi.fn(async () => undefined),
    assertNoActiveTask: vi.fn(),
    writeRun: vi.fn(),
    readRun: vi.fn(),
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

function createMockProcessManager(
  startProcess = vi.fn(async () => persistedRun),
): ProcessManager {
  return {
    startProcess,
    stopProcess: vi.fn(),
    listProcesses: vi.fn(),
    getLogs: vi.fn(),
    buildFollowLogsCommand: vi.fn(),
  } as unknown as ProcessManager;
}

describe("TaskRunner", () => {
  it("rejects tasks that are not running or stopped", async () => {
    const root = await createProjectRoot();
    const failedState: TaskState = {
      ...runningState,
      status: "failed",
    };

    const runner = new TaskRunner({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: failedState,
          })),
        }),
    });

    await expect(
      runner.run({ projectRoot: root, run: "npm start" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NO_ACTIVE_TASK,
    });
  });

  it("rejects tasks without a public IP", async () => {
    const root = await createProjectRoot();
    const noIpState: TaskState = {
      ...runningState,
      publicIp: "",
    };

    const runner = new TaskRunner({
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

    await expect(
      runner.run({ projectRoot: root, run: "npm start" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
    });
  });

  it("rejects when no run command is provided and run.sh is missing", async () => {
    const root = await createProjectRoot();

    const runner = new TaskRunner({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
    });

    await expect(runner.run({ projectRoot: root })).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.RUN_COMMAND_MISSING,
    });
  });

  it("uses .ectl/run.sh when --run is not provided", async () => {
    const root = await createProjectRoot({ includeRunScript: true });
    const startProcess = vi.fn(async () => ({
      ...persistedRun,
      command: "bash .ectl/run.sh",
      source: "run.sh" as const,
    }));

    const runner = new TaskRunner({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
      createSshManager: () => createMockSshManager(),
      createProcessManager: () => createMockProcessManager(startProcess),
    });

    await runner.run({ projectRoot: root });

    expect(startProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bash .ectl/run.sh",
        source: "run.sh",
      }),
    );
  });

  it("starts pm2 via ProcessManager and updates task state to running", async () => {
    const root = await createProjectRoot();
    const ssh = createMockSshManager();
    const writeState = vi.fn(async () => undefined);
    const startProcess = vi.fn(async () => persistedRun);
    const fixedNow = new Date("2026-07-04T14:00:00.000Z");

    const runner = new TaskRunner({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        createMockStateStore({
          writeState,
        }),
      createSshManager: () => ssh,
      createProcessManager: () => createMockProcessManager(startProcess),
      now: () => fixedNow,
    });

    const result = await runner.run({
      projectRoot: root,
      run: "npm start",
    });

    expect(ssh.connect).toHaveBeenCalledWith(
      "203.0.113.30",
      join(root, ".ectl", "keys", "ectl-key.pem"),
      "ubuntu",
      expect.objectContaining({
        onRetry: expect.any(Function),
      }),
    );
    expect(startProcess).toHaveBeenCalledWith({
      taskName: "default",
      command: "npm start",
      source: "flag",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      nodeVersion: "22",
    });
    expect(writeState).toHaveBeenCalledWith("default", {
      ...runningState,
      status: "running",
      updatedAt: fixedNow.toISOString(),
    });
    expect(ssh.dispose).toHaveBeenCalled();

    expect(result).toEqual({
      taskName: "default",
      run: persistedRun,
      status: "running",
      publicIp: "203.0.113.30",
      instanceId: "i-runnable",
    });
  });

  it("allows run for stopped tasks", async () => {
    const root = await createProjectRoot();
    const stoppedState: TaskState = {
      ...runningState,
      status: "stopped",
    };
    const startProcess = vi.fn(async () => persistedRun);

    const runner = new TaskRunner({
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
      createProcessManager: () => createMockProcessManager(startProcess),
    });

    const result = await runner.run({
      projectRoot: root,
      run: "npm start",
    });

    expect(result.status).toBe("running");
    expect(startProcess).toHaveBeenCalledOnce();
  });

  it("reads named task state when --name is provided", async () => {
    const root = await createProjectRoot();
    const readState = vi.fn(async () => runningState);
    const startProcess = vi.fn(async () => persistedRun);

    const runner = new TaskRunner({
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
      createProcessManager: () => createMockProcessManager(startProcess),
    });

    await runner.run({
      projectRoot: root,
      taskName: "default",
      run: "npm start",
    });

    expect(readState).toHaveBeenCalledWith("default");
    expect(startProcess).toHaveBeenCalledOnce();
  });

  it("throws when private key is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-run-nokey-"));
    await mkdir(join(root, ".ectl"), { recursive: true });
    await writeFile(
      join(root, ".ectl", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );

    const runner = new TaskRunner({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
    });

    await expect(
      runner.run({ projectRoot: root, run: "npm start" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NOT_INITIALIZED,
    });
  });
});
