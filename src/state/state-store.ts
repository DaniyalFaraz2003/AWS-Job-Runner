import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { ZodError } from "zod";
import {
  getRunPath,
  getStatePath,
  getTaskDir,
  getTasksDir,
} from "../config/paths.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { taskRunSchema, type TaskRun } from "../types/run.js";
import {
  isActiveTaskStatus,
  taskStateSchema,
  type TaskState,
} from "../types/state.js";

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export interface ActiveTask {
  readonly taskName: string;
  readonly state: TaskState;
}

export class StateStore {
  constructor(private readonly projectRoot: string) {}

  get tasksDir(): string {
    return getTasksDir(this.projectRoot);
  }

  taskDir(taskName: string): string {
    return getTaskDir(this.projectRoot, taskName);
  }

  statePath(taskName: string): string {
    return getStatePath(this.projectRoot, taskName);
  }

  runPath(taskName: string): string {
    return getRunPath(this.projectRoot, taskName);
  }

  async readState(taskName: string): Promise<TaskState | null> {
    let raw: string;
    try {
      raw = await readFile(this.statePath(taskName), "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Invalid JSON in .ectl/tasks/${taskName}/state.json.`,
        error,
      );
    }

    const result = taskStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Invalid .ectl/tasks/${taskName}/state.json: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    return result.data;
  }

  async writeState(taskName: string, state: TaskState): Promise<void> {
    const result = taskStateSchema.safeParse(state);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Cannot write invalid state: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    await mkdir(this.taskDir(taskName), { recursive: true });
    const content = `${JSON.stringify(result.data, null, 2)}\n`;
    await writeFile(this.statePath(taskName), content, "utf8");
  }

  async readRun(taskName: string): Promise<TaskRun | null> {
    let raw: string;
    try {
      raw = await readFile(this.runPath(taskName), "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Invalid JSON in .ectl/tasks/${taskName}/run.json.`,
        error,
      );
    }

    const result = taskRunSchema.safeParse(parsed);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Invalid .ectl/tasks/${taskName}/run.json: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    return result.data;
  }

  async writeRun(taskName: string, run: TaskRun): Promise<void> {
    const result = taskRunSchema.safeParse(run);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.STATE_INVALID,
        `Cannot write invalid run record: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    await mkdir(this.taskDir(taskName), { recursive: true });
    const content = `${JSON.stringify(result.data, null, 2)}\n`;
    await writeFile(this.runPath(taskName), content, "utf8");
  }

  async listTaskNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.tasksDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  }

  async getActiveTask(): Promise<ActiveTask | null> {
    const taskNames = await this.listTaskNames();

    for (const taskName of taskNames) {
      const state = await this.readState(taskName);
      if (state !== null && isActiveTaskStatus(state.status)) {
        return { taskName, state };
      }
    }

    return null;
  }

  async assertNoActiveTask(): Promise<void> {
    const active = await this.getActiveTask();
    if (active === null) {
      return;
    }

    throw new EctlError(
      ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS,
      `Task '${active.taskName}' is still ${active.state.status}. Run \`ectl terminate\` first.`,
    );
  }

  async assertActiveTask(): Promise<ActiveTask> {
    const active = await this.getActiveTask();
    if (active === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.NO_ACTIVE_TASK,
        "No active task found. Run `ectl deploy` or `ectl launch` first.",
      );
    }

    return active;
  }
}

export function createStateStore(projectRoot: string): StateStore {
  return new StateStore(projectRoot);
}
