import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectInitializer,
  type InitPrompts,
} from "../../src/config/project-initializer.js";
import { getConfigPath, getEctlignorePath, getPrivateKeyPath } from "../../src/config/paths.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";
import type { AwsProvisioner } from "../../src/aws/aws-provisioner.js";

const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB8s
-----END RSA PRIVATE KEY-----
`;

const TEST_AMIS = [
  {
    amiId: "ami-0abc123",
    name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260610",
    creationDate: "2026-06-10T00:00:00.000Z",
    ubuntuVersion: "24.04" as const,
  },
  {
    amiId: "ami-0def456",
    name: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260501",
    creationDate: "2026-05-01T00:00:00.000Z",
    ubuntuVersion: "22.04" as const,
  },
];

function createMockProvisioner(): AwsProvisioner {
  return {
    region: "us-east-1",
    validateCredentials: vi.fn().mockResolvedValue(undefined),
    listUbuntuAmis: vi.fn().mockResolvedValue(TEST_AMIS),
    createKeyPair: vi.fn().mockResolvedValue({
      keyPairName: "ectl-test-project-key",
      privateKeyPem: TEST_PRIVATE_KEY,
    }),
    importKeyPairFromPrivatePem: vi.fn().mockResolvedValue(undefined),
  } as unknown as AwsProvisioner;
}

const staticPrompts: InitPrompts = {
  selectRegion: async () => "us-east-1",
  selectInstanceType: async () => "t3.medium",
  selectAmi: async () => "ami-0abc123",
  confirmForce: async () => true,
};

describe("ProjectInitializer", () => {
  async function createTempProject(): Promise<string> {
    return mkdtemp(join(tmpdir(), "ectl-init-"));
  }

  it("creates .ectl layout, config, ectlignore, and gitignore", async () => {
    const projectRoot = await createTempProject();
    const initializer = createProjectInitializer({
      createProvisioner: () => createMockProvisioner(),
      getNodeVersion: () => "v22.11.0",
    });

    const result = await initializer.initialize(
      { projectRoot },
      staticPrompts,
    );

    expect(result.config.region).toBe("us-east-1");
    expect(result.config.projectSlug).toBeTruthy();
    expect(result.config.amiId).toBe("ami-0abc123");
    expect(result.config.nodeVersion).toBe("22");
    expect(result.config.keySource).toBe("generated");
    expect(result.createdEctlignore).toBe(true);
    expect(result.updatedGitignore).toBe(true);

    const configRaw = await readFile(getConfigPath(projectRoot), "utf8");
    expect(JSON.parse(configRaw).keyPairName).toMatch(/^ectl-.*-key$/);

    const pem = await readFile(getPrivateKeyPath(projectRoot), "utf8");
    expect(pem).toBe(TEST_PRIVATE_KEY);

    const ignore = await readFile(getEctlignorePath(projectRoot), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain(".ectl/");

    const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".ectl/");
  });

  it("imports an existing key when importKeyPath is set", async () => {
    const projectRoot = await createTempProject();
    const importPath = join(projectRoot, "existing.pem");
    await writeFile(importPath, TEST_PRIVATE_KEY, "utf8");

    const provisioner = createMockProvisioner();
    const initializer = createProjectInitializer({
      createProvisioner: () => provisioner,
      getNodeVersion: () => "v22.0.0",
    });

    const result = await initializer.initialize(
      { projectRoot, importKeyPath: importPath },
      staticPrompts,
    );

    expect(result.keySource).toBe("imported");
    expect(result.config.keySource).toBe("imported");
    expect(provisioner.importKeyPairFromPrivatePem).toHaveBeenCalledOnce();
    expect(provisioner.createKeyPair).not.toHaveBeenCalled();
  });

  it("fails when .ectl already exists without force", async () => {
    const projectRoot = await createTempProject();
    await mkdir(join(projectRoot, ".ectl"));

    const initializer = createProjectInitializer({
      createProvisioner: () => createMockProvisioner(),
    });

    await expect(
      initializer.initialize({ projectRoot }, staticPrompts),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.CONFIG_INVALID,
    });
  });

  it("reinitializes when force is confirmed", async () => {
    const projectRoot = await createTempProject();
    await mkdir(join(projectRoot, ".ectl"));
    await writeFile(
      join(projectRoot, ".ectl", "config.json"),
      '{"version":1}\n',
      "utf8",
    );

    const initializer = createProjectInitializer({
      createProvisioner: () => createMockProvisioner(),
      getNodeVersion: () => "v22.0.0",
    });

    const result = await initializer.initialize(
      { projectRoot, force: true },
      staticPrompts,
    );

    expect(result.config.version).toBe(1);
    expect(result.config.region).toBe("us-east-1");
  });

  it("uses flags without calling prompts for region and instance type", async () => {
    const projectRoot = await createTempProject();
    const selectRegion = vi.fn();
    const selectInstanceType = vi.fn();
    const selectAmi = vi.fn();

    const initializer = createProjectInitializer({
      createProvisioner: () => createMockProvisioner(),
      getNodeVersion: () => "v22.0.0",
    });

    await initializer.initialize(
      {
        projectRoot,
        region: "eu-west-1",
        instanceType: "t3.large",
        amiId: "ami-custom",
      },
      {
        ...staticPrompts,
        selectRegion,
        selectInstanceType,
        selectAmi,
      },
    );

    expect(selectRegion).not.toHaveBeenCalled();
    expect(selectInstanceType).not.toHaveBeenCalled();
    expect(selectAmi).not.toHaveBeenCalled();
  });

  it("uses selectAmi when amiId is not provided", async () => {
    const projectRoot = await createTempProject();
    const selectAmi = vi.fn().mockResolvedValue("ami-0def456");
    const provisioner = createMockProvisioner();

    const initializer = createProjectInitializer({
      createProvisioner: () => provisioner,
      getNodeVersion: () => "v22.0.0",
    });

    const result = await initializer.initialize(
      { projectRoot },
      { ...staticPrompts, selectAmi },
    );

    expect(provisioner.listUbuntuAmis).toHaveBeenCalledOnce();
    expect(selectAmi).toHaveBeenCalledWith(TEST_AMIS);
    expect(result.config.amiId).toBe("ami-0def456");
  });

  it("prompts for AMI before instance type and key generation", async () => {
    const projectRoot = await createTempProject();
    const callOrder: string[] = [];
    const provisioner = createMockProvisioner();

    const initializer = createProjectInitializer({
      createProvisioner: () => provisioner,
      getNodeVersion: () => "v22.0.0",
    });

    await initializer.initialize(
      { projectRoot },
      {
        selectRegion: async () => {
          callOrder.push("region");
          return "us-east-1";
        },
        selectAmi: async () => {
          callOrder.push("ami");
          return "ami-0abc123";
        },
        selectInstanceType: async () => {
          callOrder.push("instance");
          return "t3.medium";
        },
        confirmForce: async () => true,
      },
    );

    expect(callOrder).toEqual(["region", "ami", "instance"]);
    expect(provisioner.listUbuntuAmis).toHaveBeenCalledBefore(
      provisioner.createKeyPair as ReturnType<typeof vi.fn>,
    );
  });
});
