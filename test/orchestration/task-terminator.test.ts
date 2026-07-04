import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AwsProvisioner } from "../../src/aws/aws-provisioner.js";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskTerminator } from "../../src/orchestration/task-terminator.js";
import type { StateStore } from "../../src/state/state-store.js";
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
  instanceId: "i-term",
  publicIp: "203.0.113.60",
  securityGroupId: "sg-term",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T12:00:00.000Z",
  updatedAt: "2026-07-04T12:00:00.000Z",
};

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-term-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("TaskTerminator", () => {
  it("terminates instance, deletes security group, and updates state", async () => {
    const projectRoot = await createProjectRoot();
    const terminateInstance = vi.fn(async () => undefined);
    const securityGroupExists = vi.fn(async () => true);
    const deleteSecurityGroup = vi.fn(async () => undefined);
    const writeState = vi.fn(async () => undefined);
    const fixedNow = () => new Date("2026-07-04T15:00:00.000Z");

    const terminator = new TaskTerminator({
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
          writeState,
        }) as unknown as StateStore,
      createAwsProvisioner: () =>
        ({
          terminateInstance,
          securityGroupExists,
          deleteSecurityGroup,
        }) as unknown as AwsProvisioner,
      now: fixedNow,
    });

    const result = await terminator.terminate({ projectRoot });

    expect(result.alreadyTerminated).toBe(false);
    expect(result.status).toBe("terminated");
    expect(terminateInstance).toHaveBeenCalledWith("i-term");
    expect(securityGroupExists).toHaveBeenCalledWith("sg-term");
    expect(deleteSecurityGroup).toHaveBeenCalledWith("sg-term");
    expect(writeState).toHaveBeenCalledWith("default", {
      ...runningState,
      status: "terminated",
      updatedAt: "2026-07-04T15:00:00.000Z",
    });
  });

  it("returns early when task is already terminated", async () => {
    const projectRoot = await createProjectRoot();
    const terminateInstance = vi.fn();

    const terminator = new TaskTerminator({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () =>
        ({
          readState: vi.fn(async () => ({
            ...runningState,
            status: "terminated",
          })),
          writeState: vi.fn(),
        }) as unknown as StateStore,
      createAwsProvisioner: () =>
        ({
          terminateInstance,
          securityGroupExists: vi.fn(),
          deleteSecurityGroup: vi.fn(),
        }) as unknown as AwsProvisioner,
    });

    const result = await terminator.terminate({
      projectRoot,
      taskName: "default",
    });

    expect(result.alreadyTerminated).toBe(true);
    expect(result.status).toBe("terminated");
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it("skips security group deletion when it no longer exists", async () => {
    const projectRoot = await createProjectRoot();
    const deleteSecurityGroup = vi.fn();

    const terminator = new TaskTerminator({
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
          writeState: vi.fn(),
        }) as unknown as StateStore,
      createAwsProvisioner: () =>
        ({
          terminateInstance: vi.fn(async () => undefined),
          securityGroupExists: vi.fn(async () => false),
          deleteSecurityGroup,
        }) as unknown as AwsProvisioner,
    });

    await terminator.terminate({ projectRoot });

    expect(deleteSecurityGroup).not.toHaveBeenCalled();
  });
});
