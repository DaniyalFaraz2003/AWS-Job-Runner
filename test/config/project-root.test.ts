import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectRoot, requireProjectRoot } from "../../src/config/paths.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";

describe("findProjectRoot", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    tempDirs.length = 0;
  });

  async function createNestedProject(): Promise<{
    root: string;
    nested: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "ectl-root-"));
    tempDirs.push(root);
    await mkdir(join(root, ".ectl"));
    const nested = join(root, "src", "lib");
    await mkdir(nested, { recursive: true });
    return { root, nested };
  }

  it("returns the directory containing .ectl/", async () => {
    const { root, nested } = await createNestedProject();
    expect(findProjectRoot(nested)).toBe(root);
  });

  it("returns null when no .ectl/ exists in the tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ectl-none-"));
    tempDirs.push(dir);
    expect(findProjectRoot(dir)).toBeNull();
  });

  it("requireProjectRoot throws NOT_INITIALIZED when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ectl-req-"));
    tempDirs.push(dir);

    try {
      requireProjectRoot(dir);
      expect.unreachable("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EctlError);
      expect((error as EctlError).code).toBe(ECTL_ERROR_CODES.NOT_INITIALIZED);
    }
  });

  it("requireProjectRoot returns root when .ectl/ exists", async () => {
    const { root, nested } = await createNestedProject();
    expect(requireProjectRoot(nested)).toBe(root);
  });
});
