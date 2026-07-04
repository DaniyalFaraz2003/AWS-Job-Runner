import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskPuller } from "../../src/orchestration/task-puller.js";
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
  nodeVersion: "22",
  artifactPaths: ["output/", "logs/app.log"],
  projectSlug: "demo",
  tags: {},
};

const runningState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-pull",
  publicIp: "203.0.113.40",
  securityGroupId: "sg-pull",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T12:00:00.000Z",
  updatedAt: "2026-07-04T12:00:00.000Z",
};

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-pull-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("TaskPuller", () => {
  it("downloads configured artifact paths to the default task logs directory", async () => {
    const projectRoot = await createProjectRoot();
    const pullArtifacts = vi.fn(async () => [
      {
        artifactPath: "output/",
        localPath: join(projectRoot, ".ectl", "logs", "default", "output"),
        kind: "directory" as const,
      },
      {
        artifactPath: "logs/app.log",
        localPath: join(projectRoot, ".ectl", "logs", "default", "logs", "app.log"),
        kind: "file" as const,
      },
    ]);

    const puller = new TaskPuller({
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
          connect: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createTransferManager: () =>
        ({
          pullArtifacts,
        }) as unknown as TransferManager,
    });

    const result = await puller.pull({ projectRoot });

    expect(result.taskName).toBe("default");
    expect(result.localDest).toBe(join(projectRoot, ".ectl", "logs", "default"));
    expect(result.artifacts).toHaveLength(2);
    expect(pullArtifacts).toHaveBeenCalledWith({
      paths: ["output/", "logs/app.log"],
      remoteWorkDir: config.remoteWorkDir,
      localDest: join(projectRoot, ".ectl", "logs", "default"),
    });
  });

  it("uses --paths override and custom output directory", async () => {
    const projectRoot = await createProjectRoot();
    const pullArtifacts = vi.fn(async () => [
      {
        artifactPath: "reports/",
        localPath: join(projectRoot, "artifacts", "reports"),
        kind: "directory" as const,
      },
    ]);

    const puller = new TaskPuller({
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
          connect: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createTransferManager: () =>
        ({
          pullArtifacts,
        }) as unknown as TransferManager,
    });

    const result = await puller.pull({
      projectRoot,
      paths: "reports/",
      output: "artifacts",
    });

    expect(result.localDest).toBe(join(projectRoot, "artifacts"));
    expect(pullArtifacts).toHaveBeenCalledWith({
      paths: ["reports/"],
      remoteWorkDir: config.remoteWorkDir,
      localDest: join(projectRoot, "artifacts"),
    });
  });

  it("rejects empty --paths override", async () => {
    const projectRoot = await createProjectRoot();

    const puller = new TaskPuller({
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
          connect: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createTransferManager: () =>
        ({
          pullArtifacts: vi.fn(),
        }) as unknown as TransferManager,
    });

    await expect(
      puller.pull({ projectRoot, paths: " , " }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.ARTIFACT_PATHS_EMPTY,
    });
  });

  it("rejects tasks without a public IP", async () => {
    const projectRoot = await createProjectRoot();

    const puller = new TaskPuller({
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
        }) as unknown as StateStore,
      createSshManager: () =>
        ({
          connect: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createTransferManager: () =>
        ({
          pullArtifacts: vi.fn(),
        }) as unknown as TransferManager,
    });

    await expect(puller.pull({ projectRoot })).rejects.toBeInstanceOf(EctlError);
  });
});
