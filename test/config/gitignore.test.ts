import { describe, expect, it } from "vitest";
import { appendEctlToGitignore } from "../../src/config/gitignore.js";

describe("appendEctlToGitignore", () => {
  it("appends .ectl/ when missing", () => {
    const { content, updated } = appendEctlToGitignore("node_modules/\n");
    expect(updated).toBe(true);
    expect(content).toBe("node_modules/\n.ectl/\n");
  });

  it("does not duplicate an existing .ectl/ entry", () => {
    const original = "node_modules/\n.ectl/\n";
    const { content, updated } = appendEctlToGitignore(original);
    expect(updated).toBe(false);
    expect(content).toBe(original);
  });

  it("recognizes .ectl without trailing slash", () => {
    const { updated } = appendEctlToGitignore(".ectl\n");
    expect(updated).toBe(false);
  });

  it("adds a leading newline when appending to non-empty content without trailing newline", () => {
    const { content } = appendEctlToGitignore("node_modules/");
    expect(content).toBe("node_modules/\n.ectl/\n");
  });
});
