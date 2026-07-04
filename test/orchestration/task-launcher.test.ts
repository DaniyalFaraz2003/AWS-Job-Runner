import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AwsProvisioner } from "../../src/aws/aws-provisioner.js";
import type { ConfigManager } from "../../src/config/config-manager.js";
import { TaskLauncher } from "../../src/orchestration/task-launcher.js";
import type { StateStore } from "../../src/state/state-store.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";
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

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-launch-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function createMockStateStore(): StateStore {
  const written: TaskState[] = [];
  return {
    assertNoActiveTask: vi.fn(async () => undefined),
    writeState: vi.fn(async (_taskName: string, state: TaskState) => {
      written.push(state);
    }),
    readState: vi.fn(),
    readRun: vi.fn(),
    writeRun: vi.fn(),
    getActiveTask: vi.fn(),
    assertActiveTask: vi.fn(),
    listTaskNames: vi.fn(),
    tasksDir: "",
    taskDir: vi.fn(),
    statePath: vi.fn(),
    runPath: vi.fn(),
    _written: written,
  } as unknown as StateStore & { _written: TaskState[] };
}

function createMockProvisioner(): AwsProvisioner {
  return {
    launchTaskResources: vi.fn(async () => ({
      instance: { instanceId: "i-launched", publicIp: "203.0.113.10" },
      securityGroup: {
        securityGroupId: "sg-created",
        securityGroupName: "ectl-demo-default",
      },
      tags: [],
    })),
    resolveDefaultUbuntuAmiId: vi.fn(async () => "ami-resolved"),
  } as unknown as AwsProvisioner;
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

describe("TaskLauncher", () => {
  it("enforces single active task before provisioning", async () => {
    const root = await createProjectRoot();
    const stateStore = createMockStateStore();
    stateStore.assertNoActiveTask = vi.fn(async () => {
      throw new EctlError(
        ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
        "Task 'default' is still running. Run `ectl terminate` first.",
      );
    });

    const launcher = new TaskLauncher({
      createStateStore: () => stateStore,
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
    });

    await expect(
      launcher.launch({ projectRoot: root, taskName: "default" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
    });
  });

  it("writes provisioning then running state and verifies SSH", async () => {
    const root = await createProjectRoot();
    const stateStore = createMockStateStore();
    const provisioner = createMockProvisioner();
    const ssh = createMockSshManager();
    const fixedNow = new Date("2026-07-04T12:00:00.000Z");

    const launcher = new TaskLauncher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => stateStore,
      createAwsProvisioner: () => provisioner,
      createSshManager: () => ssh,
      now: () => fixedNow,
    });

    const result = await launcher.launch({
      projectRoot: root,
      taskName: "default",
    });

    expect(provisioner.launchTaskResources).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "default",
        amiId: "ami-ubuntu2204",
        allowAnyIp: false,
      }),
    );
    expect(ssh.connect).toHaveBeenCalledWith(
      "203.0.113.10",
      join(root, ".ectl", "keys", "ectl-key.pem"),
      "ubuntu",
    );
    expect(ssh.dispose).toHaveBeenCalled();

    const written = (stateStore as StateStore & { _written: TaskState[] })._written;
    expect(written[0]?.status).toBe("provisioning");
    expect(written.at(-1)?.status).toBe("running");
    expect(result.state.instanceId).toBe("i-launched");
    expect(result.state.publicIp).toBe("203.0.113.10");
  });

  it("passes allowAnyIp to AwsProvisioner", async () => {
    const root = await createProjectRoot();
    const provisioner = createMockProvisioner();

    const launcher = new TaskLauncher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
      createAwsProvisioner: () => provisioner,
      createSshManager: () => createMockSshManager(),
    });

    await launcher.launch({
      projectRoot: root,
      allowAnyIp: true,
    });

    expect(provisioner.launchTaskResources).toHaveBeenCalledWith(
      expect.objectContaining({ allowAnyIp: true }),
    );
  });

  it("sets failed state when SSH connection fails after instance launch", async () => {
    const root = await createProjectRoot();
    const stateStore = createMockStateStore();
    const ssh = createMockSshManager();
    ssh.connect = vi.fn(async () => {
      throw new EctlError(
        ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
        "Could not connect",
      );
    });

    const launcher = new TaskLauncher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => stateStore,
      createAwsProvisioner: () => createMockProvisioner(),
      createSshManager: () => ssh,
    });

    await expect(
      launcher.launch({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
    });

    const written = (stateStore as StateStore & { _written: TaskState[] })._written;
    expect(written.at(-1)).toMatchObject({
      status: "failed",
      instanceId: "i-launched",
      publicIp: "203.0.113.10",
    });
  });

  it("throws when private key is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-launch-nokey-"));
    await mkdir(join(root, ".ectl"), { recursive: true });
    await writeFile(
      join(root, ".ectl", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );

    const launcher = new TaskLauncher({
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createStateStore: () => createMockStateStore(),
    });

    await expect(
      launcher.launch({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NOT_INITIALIZED,
    });
  });
});
