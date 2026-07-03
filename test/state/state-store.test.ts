import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/state/state-store.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";
import type { TaskRun } from "../../src/types/run.js";
import type { TaskState } from "../../src/types/state.js";

const baseState: TaskState = {
  taskName: "default",
  status: "running",
  instanceId: "i-abc123",
  publicIp: "203.0.113.10",
  securityGroupId: "sg-abc123",
  keyPairName: "ectl-demo-key",
  region: "us-east-1",
  createdAt: "2026-07-03T12:00:00.000Z",
  updatedAt: "2026-07-03T12:05:00.000Z",
};

const baseRun: TaskRun = {
  command: "npm start",
  source: "flag",
  pm2ProcessName: "default",
  startedAt: "2026-07-03T12:10:00.000Z",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
};

async function createProject(): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "ectl-state-"));
  await mkdir(join(root, ".ectl", "tasks"), { recursive: true });
  return { root, store: new StateStore(root) };
}

async function writeStateFixture(
  root: string,
  taskName: string,
  state: TaskState,
): Promise<void> {
  const dir = join(root, ".ectl", "tasks", taskName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

describe("StateStore", () => {
  it("returns null when state.json is missing", async () => {
    const { store } = await createProject();
    expect(await store.readState("default")).toBeNull();
  });

  it("reads and writes state.json", async () => {
    const { store } = await createProject();
    await store.writeState("default", baseState);
    expect(await store.readState("default")).toEqual(baseState);
  });

  it("reads and writes run.json", async () => {
    const { store } = await createProject();
    await store.writeRun("default", baseRun);
    expect(await store.readRun("default")).toEqual(baseRun);
  });

  it("throws STATE_INVALID for malformed state.json", async () => {
    const { root, store } = await createProject();
    const dir = join(root, ".ectl", "tasks", "default");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), "{ not json", "utf8");

    await expect(store.readState("default")).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.STATE_INVALID,
    });
  });

  it("getActiveTask returns a task in an active status", async () => {
    const { root, store } = await createProject();
    await writeStateFixture(root, "default", baseState);

    const active = await store.getActiveTask();
    expect(active).toEqual({ taskName: "default", state: baseState });
  });

  it("getActiveTask ignores completed and terminated tasks", async () => {
    const { root, store } = await createProject();
    await writeStateFixture(root, "old", {
      ...baseState,
      taskName: "old",
      status: "terminated",
    });
    await writeStateFixture(root, "done", {
      ...baseState,
      taskName: "done",
      status: "completed",
    });

    expect(await store.getActiveTask()).toBeNull();
  });

  it("treats provisioning, stopped, and failed as active", async () => {
    for (const status of ["provisioning", "stopped", "failed"] as const) {
      const { root, store } = await createProject();
      await writeStateFixture(root, "default", { ...baseState, status });
      const active = await store.getActiveTask();
      expect(active?.state.status).toBe(status);
    }
  });

  it("assertNoActiveTask throws ACTIVE_TASK_EXISTS when a task is active", async () => {
    const { root, store } = await createProject();
    await writeStateFixture(root, "default", baseState);

    await expect(store.assertNoActiveTask()).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
    });
  });

  it("assertNoActiveTask succeeds when no active task exists", async () => {
    const { store } = await createProject();
    await expect(store.assertNoActiveTask()).resolves.toBeUndefined();
  });

  it("assertActiveTask throws NO_ACTIVE_TASK when none exists", async () => {
    const { store } = await createProject();

    await expect(store.assertActiveTask()).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NO_ACTIVE_TASK,
    });
  });

  it("assertActiveTask returns the active task", async () => {
    const { root, store } = await createProject();
    await writeStateFixture(root, "worker", {
      ...baseState,
      taskName: "worker",
    });

    const active = await store.assertActiveTask();
    expect(active.taskName).toBe("worker");
    expect(active.state.status).toBe("running");
  });

  it("rejects writing invalid state", async () => {
    const { store } = await createProject();

    await expect(
      store.writeState("default", { ...baseState, status: "invalid" } as never),
    ).rejects.toBeInstanceOf(EctlError);
  });
});
