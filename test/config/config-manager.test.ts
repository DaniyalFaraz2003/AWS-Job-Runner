import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigManager } from "../../src/config/config-manager.js";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";
import { ectlConfigSchema } from "../../src/types/config.js";

const validConfig = {
  version: 1,
  region: "us-east-1",
  instanceType: "t3.medium",
  sshUser: "ubuntu",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
  keyPairName: "ectl-my-project-key",
  keySource: "generated" as const,
  artifactPaths: [],
  projectSlug: "my-project",
  tags: {},
};

describe("ectlConfigSchema", () => {
  it("accepts a valid config", () => {
    const result = ectlConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = ectlConfigSchema.safeParse({ version: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid keySource", () => {
    const result = ectlConfigSchema.safeParse({
      ...validConfig,
      keySource: "copied",
    });
    expect(result.success).toBe(false);
  });
});

describe("ConfigManager", () => {
  async function createProjectWithConfig(
    config: unknown,
  ): Promise<{ root: string; manager: ConfigManager }> {
    const root = await mkdtemp(join(tmpdir(), "ectl-cfg-"));
    await mkdir(join(root, ".ectl"));
    await writeFile(
      join(root, ".ectl", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    return { root, manager: new ConfigManager(root) };
  }

  it("reads and validates config.json", async () => {
    const { manager } = await createProjectWithConfig(validConfig);
    const config = await manager.read();
    expect(config.region).toBe("us-east-1");
    expect(config.projectSlug).toBe("my-project");
  });

  it("throws CONFIG_INVALID for malformed JSON shape", async () => {
    const { manager } = await createProjectWithConfig({ version: 2 });

    await expect(manager.read()).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.CONFIG_INVALID,
    });
  });

  it("throws NOT_INITIALIZED when config.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-no-cfg-"));
    await mkdir(join(root, ".ectl"));
    const manager = new ConfigManager(root);

    await expect(manager.read()).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it("writes validated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-write-"));
    await mkdir(join(root, ".ectl"));
    const manager = new ConfigManager(root);

    await manager.write(validConfig);
    const readBack = await manager.read();
    expect(readBack).toEqual(validConfig);
  });

  it("rejects writing invalid config", async () => {
    const root = await mkdtemp(join(tmpdir(), "ectl-bad-write-"));
    await mkdir(join(root, ".ectl"));
    const manager = new ConfigManager(root);

    await expect(
      manager.write({ ...validConfig, version: 2 } as never),
    ).rejects.toBeInstanceOf(EctlError);
  });
});
