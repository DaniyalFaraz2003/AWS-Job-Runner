import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveRunCommand,
  RUN_SCRIPT_REMOTE_COMMAND,
} from "../../src/process/resolve-run-command.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";

async function createProject(withRunScript = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ectl-run-cmd-"));
  await mkdir(join(root, ".ectl"), { recursive: true });

  if (withRunScript) {
    await writeFile(join(root, ".ectl", "run.sh"), "#!/bin/bash\nnpm start\n", "utf8");
  }

  return root;
}

describe("resolveRunCommand", () => {
  it("prefers --run flag over .ectl/run.sh", async () => {
    const root = await createProject(true);

    const resolved = resolveRunCommand("npm run build", root);

    expect(resolved).toEqual({ command: "npm run build", source: "flag" });
  });

  it("uses .ectl/run.sh when no flag is provided", async () => {
    const root = await createProject(true);

    const resolved = resolveRunCommand(undefined, root);

    expect(resolved).toEqual({
      command: RUN_SCRIPT_REMOTE_COMMAND,
      source: "run.sh",
    });
  });

  it("throws RUN_COMMAND_MISSING when neither flag nor run.sh exists", async () => {
    const root = await createProject(false);

    expect(() => resolveRunCommand(undefined, root)).toThrow(EctlError);

    try {
      resolveRunCommand(undefined, root);
    } catch (error) {
      expect(error).toBeInstanceOf(EctlError);
      expect((error as EctlError).code).toBe(ECTL_ERROR_CODES.RUN_COMMAND_MISSING);
    }
  });

  it("treats blank --run as missing and falls back to run.sh", async () => {
    const root = await createProject(true);

    const resolved = resolveRunCommand("   ", root);

    expect(resolved.source).toBe("run.sh");
  });
});
