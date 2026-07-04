import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AwsProvisioner } from "../../src/aws/aws-provisioner.js";
import type { ConfigManager } from "../../src/config/config-manager.js";
import {
  isNoActiveTaskResult,
  syncStateFromAwsInstance,
  TaskStatusChecker,
} from "../../src/orchestration/task-status.js";
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
  artifactPaths: [],
  projectSlug: "demo",
  tags: {},
};

const baseState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-abc123",
  publicIp: "203.0.113.10",
  securityGroupId: "sg-abc123",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-04T10:00:00.000Z",
  updatedAt: "2026-07-04T10:00:00.000Z",
};

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-status-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(join(root, ".ectl", "keys", "ectl-key.pem"), "fake-key\n", "utf8");
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function createMockStateStore(
  options: {
    active?: { taskName: string; state: TaskState } | null;
    run?: TaskRun | null;
  } = {},
): StateStore {
  const active =
    options.active === undefined
      ? { taskName: "default", state: baseState }
      : options.active;
  const run = options.run ?? null;

  return {
    getActiveTask: vi.fn(async () => active),
    readState: vi.fn(async (taskName: string) =>
      active !== null && taskName === active.taskName ? active.state : null,
    ),
    writeState: vi.fn(async () => undefined),
    readRun: vi.fn(async () => run),
    writeRun: vi.fn(),
    assertActiveTask: vi.fn(),
    assertNoActiveTask: vi.fn(),
    listTaskNames: vi.fn(),
    tasksDir: "",
    taskDir: vi.fn(),
    statePath: vi.fn(),
    runPath: vi.fn(),
  } as unknown as StateStore;
}

function createMockProvisioner(
  options: {
    describe?: ReturnType<AwsProvisioner["tryDescribeInstance"]> extends Promise<infer T>
      ? T
      : never;
    securityGroupExists?: boolean;
  } = {},
): AwsProvisioner {
  return {
    tryDescribeInstance: vi.fn(async () =>
      options.describe === undefined
        ? {
            instanceId: "i-abc123",
            stateName: "running",
            publicIp: "203.0.113.10",
            securityGroupIds: ["sg-abc123"],
          }
        : options.describe,
    ),
    securityGroupExists: vi.fn(async () => options.securityGroupExists ?? true),
  } as unknown as AwsProvisioner;
}

describe("syncStateFromAwsInstance", () => {
  it("maps terminated AWS state to terminated task status", () => {
    const result = syncStateFromAwsInstance(
      baseState,
      {
        instanceId: "i-abc123",
        stateName: "terminated",
        publicIp: "",
        securityGroupIds: [],
      },
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.state.status).toBe("terminated");
    expect(result.publicIpChanged).toBe(false);
  });

  it("updates public IP when AWS reports a new address", () => {
    const result = syncStateFromAwsInstance(
      baseState,
      {
        instanceId: "i-abc123",
        stateName: "running",
        publicIp: "203.0.113.99",
        securityGroupIds: ["sg-abc123"],
      },
      "2026-07-04T12:00:00.000Z",
    );

    expect(result.state.publicIp).toBe("203.0.113.99");
    expect(result.publicIpChanged).toBe(true);
  });
});

describe("TaskStatusChecker", () => {
  it("returns noActiveTask when nothing is active", async () => {
    const root = await createProjectRoot();
    const checker = new TaskStatusChecker({
      createStateStore: () => createMockStateStore({ active: null }),
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
    });

    const result = await checker.status({ projectRoot: root });
    expect(isNoActiveTaskResult(result)).toBe(true);
  });

  it("marks task terminated when AWS instance is missing", async () => {
    const root = await createProjectRoot();
    const stateStore = createMockStateStore();
    const provisioner = createMockProvisioner({ describe: null });

    const checker = new TaskStatusChecker({
      createStateStore: () => stateStore,
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createAwsProvisioner: () => provisioner,
      createSshManager: () =>
        ({
          connect: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      now: () => new Date("2026-07-04T12:00:00.000Z"),
    });

    const result = await checker.status({ projectRoot: root });
    expect(isNoActiveTaskResult(result)).toBe(false);
    if (isNoActiveTaskResult(result)) {
      throw new Error("expected task snapshot");
    }

    expect(result.state.status).toBe("terminated");
    expect(result.reconciliation.instanceFound).toBe(false);
    expect(result.reconciliation.warnings).toContain(
      "EC2 instance 'i-abc123' no longer exists in AWS. Local state updated to terminated.",
    );
    expect(stateStore.writeState).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        status: "terminated",
        lastReconciledAt: "2026-07-04T12:00:00.000Z",
      }),
    );
  });

  it("includes pm2 status when SSH is reachable", async () => {
    const root = await createProjectRoot();
    const run: TaskRun = {
      command: "npm start",
      source: "flag",
      pm2ProcessName: "default",
      startedAt: "2026-07-04T11:00:00.000Z",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
    };

    const checker = new TaskStatusChecker({
      createStateStore: () =>
        createMockStateStore({
          active: { taskName: "default", state: baseState },
          run,
        }),
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createAwsProvisioner: () => createMockProvisioner(),
      createSshManager: () =>
        ({
          connect: vi.fn(async () => undefined),
          dispose: vi.fn(),
        }) as unknown as SshManager,
      createProcessManager: () =>
        ({
          listProcesses: vi.fn(async () => [
            { name: "default", status: "online", pmId: 0, pid: 1234 },
          ]),
        }) as unknown as ProcessManager,
    });

    const result = await checker.status({ projectRoot: root });
    if (isNoActiveTaskResult(result)) {
      throw new Error("expected task snapshot");
    }

    expect(result.pm2).toEqual({
      name: "default",
      status: "online",
      pmId: 0,
      pid: 1234,
    });
    expect(result.pm2Unreachable).toBe(false);
  });

  it("reports pm2 as unreachable when SSH fails without throwing", async () => {
    const root = await createProjectRoot();
    const checker = new TaskStatusChecker({
      createStateStore: () => createMockStateStore(),
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
      createAwsProvisioner: () => createMockProvisioner(),
      createSshManager: () =>
        ({
          connect: vi.fn(async () => {
            throw new EctlError(
              ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
              "SSH failed",
            );
          }),
          dispose: vi.fn(),
        }) as unknown as SshManager,
    });

    const result = await checker.status({ projectRoot: root });
    if (isNoActiveTaskResult(result)) {
      throw new Error("expected task snapshot");
    }

    expect(result.pm2).toBeNull();
    expect(result.pm2Unreachable).toBe(true);
  });

  it("throws when --name task does not exist", async () => {
    const root = await createProjectRoot();
    const checker = new TaskStatusChecker({
      createStateStore: () => createMockStateStore({ active: null }),
      createConfigManager: () =>
        ({
          read: vi.fn(async () => config),
        }) as unknown as ConfigManager,
    });

    await expect(
      checker.status({ projectRoot: root, taskName: "missing" }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NO_ACTIVE_TASK,
    });
  });
});
