import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskSshSession } from "../../src/orchestration/task-ssh.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
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
  nodeVersion: "22",
  artifactPaths: [],
  projectSlug: "demo",
  tags: {},
};

const runningState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-ssh",
  publicIp: "203.0.113.60",
  securityGroupId: "sg-ssh",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T12:00:00.000Z",
  updatedAt: "2026-07-04T12:00:00.000Z",
};

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-ssh-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("TaskSshSession", () => {
  it("connects with project key and opens an interactive shell", async () => {
    const projectRoot = await createProjectRoot();
    const connect = vi.fn(async () => undefined);
    const openShell = vi.fn(async () => undefined);
    const dispose = vi.fn();

    const session = new TaskSshSession({
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
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect,
          openShell,
          dispose,
        }) as unknown as SshManager,
    });

    const result = await session.open({ projectRoot });

    expect(result.host).toBe("ubuntu@203.0.113.60");
    expect(connect).toHaveBeenCalledWith(
      "203.0.113.60",
      join(projectRoot, ".ectl", "keys", "ectl-key.pem"),
      "ubuntu",
    );
    expect(openShell).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
  });
});
