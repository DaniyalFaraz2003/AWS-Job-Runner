import { describe, expect, it } from "vitest";
import { buildKeyPairName, deriveProjectSlug } from "../../src/config/project-slug.js";

describe("deriveProjectSlug", () => {
  it("lowercases and hyphenates the directory name", () => {
    expect(deriveProjectSlug("C:\\Projects\\My Batch Job")).toBe("my-batch-job");
  });

  it("falls back to project for empty slugs", () => {
    expect(deriveProjectSlug("C:\\Projects\\!!!")).toBe("project");
  });
});

describe("buildKeyPairName", () => {
  it("prefixes the project slug", () => {
    expect(buildKeyPairName("my-project")).toBe("ectl-my-project-key");
  });
});
