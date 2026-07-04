import type { ActiveTask, StateStore } from "../state/state-store.js";
import { resolveTaskName } from "../state/task-name.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TaskState, TaskStatus } from "../types/state.js";

const REACHABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "stopped",
  "failed",
] as const;

/** Resolve a task whose EC2 instance should be reachable over SSH (FR-SSH-3, FR-LOGS-*, FR-STOP-*). */
export async function resolveReachableTask(
  stateStore: StateStore,
  taskNameInput?: string,
): Promise<ActiveTask> {
  if (taskNameInput !== undefined) {
    const taskName = resolveTaskName(taskNameInput);
    const state = await stateStore.readState(taskName);
    if (state === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.NO_ACTIVE_TASK,
        `Task '${taskName}' not found. Run \`ectl launch\` first.`,
      );
    }

    assertReachableState(taskName, state);
    return { taskName, state };
  }

  const active = await stateStore.assertActiveTask();
  assertReachableState(active.taskName, active.state);
  return active;
}

function assertReachableState(taskName: string, state: TaskState): void {
  if (!(REACHABLE_TASK_STATUSES as readonly string[]).includes(state.status)) {
    throw new EctlError(
      ECTL_ERROR_CODES.NO_ACTIVE_TASK,
      `Task '${taskName}' is ${state.status}. Requires a running, stopped, or failed task with a public IP. Run \`ectl launch\` first.`,
    );
  }

  if (state.publicIp.trim().length === 0) {
    throw new EctlError(
      ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
      `Task '${taskName}' has no public IP. Check default VPC settings or run \`ectl status\`.`,
    );
  }
}
