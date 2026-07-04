import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { TaskOrchestrator } from "../../src/orchestration/task-orchestrator.js";
import type { TaskLauncher } from "../../src/orchestration/task-launcher.js";
import type { TaskPusher } from "../../src/orchestration/task-pusher.js";
import type { TaskRunner } from "../../src/orchestration/task-runner.js";
import type { StateStore } from "../../src/state/state-store.js";
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
  instanceId: "i-deployed",
  publicIp: "203.0.113.50",
  securityGroupId: "sg-deployed",
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
  const root = await mkdtemp(join(tmpdir(), "ectl-deploy-"));
  await mkdir(join(root, ".ectl", "keys"), { recursive: true });
  await writeFile(
    join(root, ".ectl", "keys", "ectl-key.pem"),
    "fake-key\n",
    "utf8",
  );
  await writeFile(
    join(root, ".ectl", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  if (options?.includeRunScript === true) {
    await writeFile(
      join(root, ".ectl", "run.sh"),
      "#!/bin/bash\nnpm start\n",
      "utf8",
    );
  }
  return root;
}

function createMockStateStore(
  initialState: TaskState | null = runningState,
): StateStore & { written: TaskState[] } {
  let current = initialState;
  const written: TaskState[] = [];

  return {
    assertNoActiveTask: vi.fn(),
    assertActiveTask: vi.fn(),
    readState: vi.fn(async () => current),
    writeState: vi.fn(async (_taskName: string, state: TaskState) => {
      current = state;
      written.push(state);
    }),
    readRun: vi.fn(),
    writeRun: vi.fn(),
    getActiveTask: vi.fn(),
    listTaskNames: vi.fn(),
    tasksDir: "",
    taskDir: vi.fn(),
    statePath: vi.fn(),
    runPath: vi.fn(),
    written,
  } as unknown as StateStore & { written: TaskState[] };
}

describe("TaskOrchestrator", () => {
  it("runs launch, push, and run in order on success", async () => {
    const root = await createProjectRoot();
    const launch = vi.fn(async () => ({
      taskName: "default",
      state: runningState,
    }));
    const push = vi.fn(async () => ({
      taskName: "default",
      remoteWorkDir: config.remoteWorkDir,
      publicIp: runningState.publicIp,
      instanceId: runningState.instanceId,
    }));
    const run = vi.fn(async () => ({
      taskName: "default",
      run: persistedRun,
      status: "running" as const,
      publicIp: runningState.publicIp,
      instanceId: runningState.instanceId,
    }));

    const orchestrator = new TaskOrchestrator({
      createTaskLauncher: () => ({ launch }) as unknown as TaskLauncher,
      createTaskPusher: () => ({ push }) as unknown as TaskPusher,
      createTaskRunner: () => ({ run }) as unknown as TaskRunner,
    });

    const result = await orchestrator.deploy({
      projectRoot: root,
      run: "npm start",
    });

    expect(launch).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(launch.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0]!,
    );
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      taskName: "default",
      instanceId: runningState.instanceId,
      publicIp: runningState.publicIp,
      status: "running",
      remoteWorkDir: config.remoteWorkDir,
      run: persistedRun,
    });
  });

  it("rejects deploy when no run command is available", async () => {
    const root = await createProjectRoot();
    const launch = vi.fn();

    const orchestrator = new TaskOrchestrator({
      createTaskLauncher: () => ({ launch }) as unknown as TaskLauncher,
      createTaskPusher: () => ({ push: vi.fn() }) as unknown as TaskPusher,
      createTaskRunner: () => ({ run: vi.fn() }) as unknown as TaskRunner,
    });

    await expect(orchestrator.deploy({ projectRoot: root })).rejects.toMatchObject(
      {
        code: ECTL_ERROR_CODES.RUN_COMMAND_MISSING,
      },
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("propagates ACTIVE_TASK_EXISTS without partial failure wrapping", async () => {
    const root = await createProjectRoot({ includeRunScript: true });
    const launch = vi.fn(async () => {
      throw new EctlError(
        ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
        "Task 'default' is still running. Run `ectl terminate` first.",
      );
    });

    const orchestrator = new TaskOrchestrator({
      createTaskLauncher: () => ({ launch }) as unknown as TaskLauncher,
      createTaskPusher: () => ({ push: vi.fn() }) as unknown as TaskPusher,
      createTaskRunner: () => ({ run: vi.fn() }) as unknown as TaskRunner,
    });

    await expect(
      orchestrator.deploy({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
    });
  });

  it("marks state failed and throws DEPLOY_PARTIAL_FAILURE when push fails", async () => {
    const root = await createProjectRoot({ includeRunScript: true });
    const stateStore = createMockStateStore();
    const fixedNow = () => new Date("2026-07-04T14:00:00.000Z");

    const orchestrator = new TaskOrchestrator({
      createStateStore: () => stateStore,
      createTaskLauncher: () =>
        ({
          launch: vi.fn(async () => ({
            taskName: "default",
            state: runningState,
          })),
        }) as unknown as TaskLauncher,
      createTaskPusher: () =>
        ({
          push: vi.fn(async () => {
            throw new EctlError(
              ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
              "Cannot connect after retries.",
            );
          }),
        }) as unknown as TaskPusher,
      createTaskRunner: () => ({ run: vi.fn() }) as unknown as TaskRunner,
      now: fixedNow,
    });

    await expect(
      orchestrator.deploy({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.DEPLOY_PARTIAL_FAILURE,
    });

    expect(stateStore.written.at(-1)).toMatchObject({
      status: "failed",
      instanceId: runningState.instanceId,
      updatedAt: fixedNow().toISOString(),
    });
  });

  it("marks state failed and throws DEPLOY_PARTIAL_FAILURE when run fails", async () => {
    const root = await createProjectRoot({ includeRunScript: true });
    const stateStore = createMockStateStore();

    const orchestrator = new TaskOrchestrator({
      createStateStore: () => stateStore,
      createTaskLauncher: () =>
        ({
          launch: vi.fn(async () => ({
            taskName: "default",
            state: runningState,
          })),
        }) as unknown as TaskLauncher,
      createTaskPusher: () =>
        ({
          push: vi.fn(async () => ({
            taskName: "default",
            remoteWorkDir: config.remoteWorkDir,
            publicIp: runningState.publicIp,
            instanceId: runningState.instanceId,
          })),
        }) as unknown as TaskPusher,
      createTaskRunner: () =>
        ({
          run: vi.fn(async () => {
            throw new EctlError(
              ECTL_ERROR_CODES.RUN_COMMAND_MISSING,
              "pm2 failed to start.",
            );
          }),
        }) as unknown as TaskRunner,
    });

    const error = await orchestrator
      .deploy({ projectRoot: root })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: ECTL_ERROR_CODES.DEPLOY_PARTIAL_FAILURE,
    });
    expect(String((error as EctlError).message)).toContain("ectl status");
    expect(String((error as EctlError).message)).toContain("ectl terminate");
    expect(stateStore.written.at(-1)?.status).toBe("failed");
  });

  it("does not wrap launch failures when no instance was created", async () => {
    const root = await createProjectRoot({ includeRunScript: true });
    const failedProvisioningState: TaskState = {
      ...runningState,
      status: "failed",
      instanceId: "",
      publicIp: "",
      securityGroupId: "",
    };
    const stateStore = createMockStateStore(failedProvisioningState);

    const orchestrator = new TaskOrchestrator({
      createStateStore: () => stateStore,
      createTaskLauncher: () =>
        ({
          launch: vi.fn(async () => {
            throw new EctlError(
              ECTL_ERROR_CODES.AWS_CREDENTIALS_INVALID,
              "Invalid credentials.",
            );
          }),
        }) as unknown as TaskLauncher,
      createTaskPusher: () => ({ push: vi.fn() }) as unknown as TaskPusher,
      createTaskRunner: () => ({ run: vi.fn() }) as unknown as TaskRunner,
    });

    await expect(
      orchestrator.deploy({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.AWS_CREDENTIALS_INVALID,
    });
  });
});
