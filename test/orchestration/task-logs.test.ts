import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskLogsFetcher } from "../../src/orchestration/task-logs.js";
import type { ProcessManager } from "../../src/process/process-manager.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";
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
  instanceId: "i-logs",
  publicIp: "203.0.113.40",
  securityGroupId: "sg-logs",
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
  const root = await mkdtemp(join(tmpdir(), "ectl-logs-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("TaskLogsFetcher", () => {
  it("fetches pm2 logs for the active task", async () => {
    const projectRoot = await createProjectRoot();
    const connect = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const getLogs = vi.fn(async () => "log line\n");

    const fetcher = new TaskLogsFetcher({
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
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect,
          dispose,
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          getLogs,
          buildFollowLogsCommand: vi.fn(),
          streamLogs: vi.fn(),
        }) as unknown as ProcessManager,
    });

    const result = await fetcher.fetch({ projectRoot, lines: 50 });

    expect(result.output).toBe("log line\n");
    expect(result.processName).toBe("default");
    expect(result.followed).toBe(false);
    expect(result.lines).toBe(50);
    expect(connect).toHaveBeenCalledWith(
      "203.0.113.40",
      join(projectRoot, ".ectl", "keys", "ectl-key.pem"),
      "ubuntu",
    );
    expect(getLogs).toHaveBeenCalledWith("default", { lines: 50 });
    expect(dispose).toHaveBeenCalled();
  });

  it("streams logs when follow is enabled", async () => {
    const projectRoot = await createProjectRoot();
    const streamLogs = vi.fn(async () => undefined);
    const buildFollowLogsCommand = vi.fn(
      () => "pm2 logs 'default' --lines 25",
    );

    const fetcher = new TaskLogsFetcher({
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
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          getLogs: vi.fn(),
          buildFollowLogsCommand,
          streamLogs,
        }) as unknown as ProcessManager,
    });

    const result = await fetcher.fetch({
      projectRoot,
      lines: 25,
      follow: true,
    });

    expect(result.followed).toBe(true);
    expect(buildFollowLogsCommand).toHaveBeenCalledWith("default", { lines: 25 });
    expect(streamLogs).toHaveBeenCalled();
  });

  it("rejects tasks without a public IP", async () => {
    const projectRoot = await createProjectRoot();

    const fetcher = new TaskLogsFetcher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        ({
          assertActiveTask: vi.fn(async () => ({
            taskName: "default",
            state: { ...runningState, publicIp: "" },
          })),
          readRun: vi.fn(async () => persistedRun),
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          getLogs: vi.fn(),
          buildFollowLogsCommand: vi.fn(),
          streamLogs: vi.fn(),
        }) as unknown as ProcessManager,
    });

    await expect(fetcher.fetch({ projectRoot })).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
    });
  });
});
