import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskStopper } from "../../src/orchestration/task-stopper.js";
import type { ProcessManager } from "../../src/process/process-manager.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
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
  instanceId: "i-stop",
  publicIp: "203.0.113.50",
  securityGroupId: "sg-stop",
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

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-stop-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("TaskStopper", () => {
  it("stops pm2 and updates task state to stopped", async () => {
    const projectRoot = await createProjectRoot();
    const writeState = vi.fn(async () => undefined);
    const stopProcess = vi.fn(async () => undefined);
    const fixedNow = () => new Date("2026-07-04T14:00:00.000Z");

    const stopper = new TaskStopper({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        ({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: runningState,
          })),
          readRun: vi.fn(async () => persistedRun),
          writeState,
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          stopProcess,
        }) as unknown as ProcessManager,
      now: fixedNow,
    });

    const result = await stopper.stop({ projectRoot });

    expect(result.status).toBe("stopped");
    expect(result.alreadyStopped).toBe(false);
    expect(stopProcess).toHaveBeenCalledWith("default");
    expect(writeState).toHaveBeenCalledWith("default", {
      ...runningState,
      status: "stopped",
      updatedAt: "2026-07-04T14:00:00.000Z",
    });
  });

  it("returns early when task is already stopped", async () => {
    const projectRoot = await createProjectRoot();
    const connect = vi.fn();

    const stopper = new TaskStopper({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        ({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: { ...runningState, status: "stopped" },
          })),
          readRun: vi.fn(async () => persistedRun),
          writeState: vi.fn(),
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect,
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          stopProcess: vi.fn(),
        }) as unknown as ProcessManager,
    });

    const result = await stopper.stop({ projectRoot });

    expect(result.alreadyStopped).toBe(true);
    expect(result.status).toBe("stopped");
    expect(connect).not.toHaveBeenCalled();
  });
});
