/** Default task name when `--name` is omitted (SRS §4.6). */
export const DEFAULT_TASK_NAME = "default";

export function resolveTaskName(name?: string): string {
  return name ?? DEFAULT_TASK_NAME;
}
