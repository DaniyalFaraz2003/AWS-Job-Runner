import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_NAME,
  resolveTaskName,
} from "../../src/state/task-name.js";

describe("resolveTaskName", () => {
  it("returns default when name is omitted", () => {
    expect(resolveTaskName()).toBe(DEFAULT_TASK_NAME);
    expect(resolveTaskName(undefined)).toBe("default");
  });

  it("returns the provided name", () => {
    expect(resolveTaskName("batch-1")).toBe("batch-1");
  });
});
