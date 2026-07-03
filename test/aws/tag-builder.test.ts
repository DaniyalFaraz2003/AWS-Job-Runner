import { describe, expect, it } from "vitest";
import { buildEctlTags, tagsToRecord } from "../../src/aws/tag-builder.js";

describe("buildEctlTags", () => {
  it("includes required ectl tags", () => {
    const tags = buildEctlTags({
      projectSlug: "my-project",
      taskName: "default",
      createdAt: "2026-07-03T12:00:00.000Z",
      createdBy: "dev-user",
    });

    expect(tagsToRecord(tags)).toEqual({
      "ectl:project": "my-project",
      "ectl:task": "default",
      "ectl:created-at": "2026-07-03T12:00:00.000Z",
      "ectl:created-by": "dev-user",
    });
  });

  it("merges extra config tags", () => {
    const tags = buildEctlTags({
      projectSlug: "demo",
      taskName: "batch",
      createdAt: "2026-07-03T12:00:00.000Z",
      createdBy: "dev-user",
      extraTags: { Environment: "test" },
    });

    expect(tagsToRecord(tags)).toMatchObject({
      "ectl:project": "demo",
      Environment: "test",
    });
  });
});
