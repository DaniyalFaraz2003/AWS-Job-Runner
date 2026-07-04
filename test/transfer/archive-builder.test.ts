import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultEctlignoreContent } from "../../src/config/ectlignore.js";
import { ArchiveBuilder } from "../../src/transfer/archive-builder.js";

const execFileAsync = promisify(execFile);

async function listZipEntries(zipPath: string): Promise<string[]> {
  const escaped = zipPath.replace(/'/g, "''");
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${escaped}').Entries | ForEach-Object { $_.FullName }`,
  ]);

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function createFixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ectl-archive-fixture-"));

  await writeFile(join(projectRoot, "app.js"), 'console.log("app");\n');
  await writeFile(join(projectRoot, ".ectlignore"), defaultEctlignoreContent());

  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "index.ts"), "export {};\n");

  await mkdir(join(projectRoot, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(projectRoot, "node_modules", "pkg", "index.js"), "module;\n");

  await mkdir(join(projectRoot, ".ectl", "keys"), { recursive: true });
  await writeFile(join(projectRoot, ".ectl", "config.json"), "{}\n");

  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await writeFile(join(projectRoot, "dist", "bundle.js"), "bundle;\n");

  return projectRoot;
}

describe("ArchiveBuilder", () => {
  it("excludes node_modules, .ectl, and dist from the zip", async () => {
    const projectRoot = await createFixtureProject();
    const builder = new ArchiveBuilder();

    const result = await builder.build({ projectRoot });

    try {
      expect(result.totalBytes).toBeGreaterThan(0);

      const entries = await listZipEntries(result.archivePath);
      expect(entries).toContain("app.js");
      expect(entries).toContain("src/index.ts");
      expect(entries.some((entry) => entry.startsWith("node_modules/"))).toBe(
        false,
      );
      expect(entries.some((entry) => entry.startsWith(".ectl/"))).toBe(false);
      expect(entries.some((entry) => entry.startsWith("dist/"))).toBe(false);
    } finally {
      await result.cleanup();
    }
  });

  it("invokes archive progress hooks", async () => {
    const projectRoot = await createFixtureProject();
    const builder = new ArchiveBuilder();
    const events: string[] = [];

    const result = await builder.build({
      projectRoot,
      progress: {
        onArchiveStart: () => events.push("start"),
        onArchiveComplete: (bytes) => events.push(`complete:${String(bytes)}`),
      },
    });

    try {
      expect(events[0]).toBe("start");
      expect(events.at(-1)).toMatch(/^complete:/);
    } finally {
      await result.cleanup();
    }
  });
});
