import { readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { UbuntuAmiCandidate } from "../aws/ami-resolver.js";
import {
  createAwsProvisioner,
  type AwsProvisioner,
} from "../aws/aws-provisioner.js";
import type { EctlConfig } from "../types/config.js";
import { DEFAULT_ECTL_CONFIG } from "../types/config.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { ConfigManager } from "./config-manager.js";
import { defaultEctlignoreContent } from "./ectlignore.js";
import { appendEctlToGitignore } from "./gitignore.js";
import {
  ectlDirExists,
  getEctlDir,
  getEctlignorePath,
  getKeysDir,
  getLogsDir,
  getPrivateKeyPath,
  getTasksDir,
} from "./paths.js";
import { buildKeyPairName, deriveProjectSlug } from "./project-slug.js";

export interface InitOptions {
  readonly projectRoot: string;
  readonly region?: string;
  readonly instanceType?: string;
  readonly amiId?: string;
  readonly importKeyPath?: string;
  readonly force?: boolean;
}

export interface InitResult {
  readonly projectRoot: string;
  readonly config: EctlConfig;
  readonly keySource: "generated" | "imported";
  readonly createdEctlignore: boolean;
  readonly updatedGitignore: boolean;
}

export interface InitPrompts {
  selectRegion(defaultRegion: string): Promise<string>;
  selectInstanceType(defaultType: string): Promise<string>;
  selectAmi(candidates: readonly UbuntuAmiCandidate[]): Promise<string>;
  confirmForce(): Promise<boolean>;
}

export interface ProjectInitializerDeps {
  readonly createProvisioner?: (region: string) => AwsProvisioner;
  readonly getNodeVersion?: () => string;
}

const DEFAULT_INSTANCE_TYPES = [
  "t3.micro",
  "t3.small",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
] as const;

function resolveDefaultRegion(): string {
  return (
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    "us-east-1"
  );
}

function getLocalNodeMajorVersion(getNodeVersion: () => string): string {
  const match = /^v(\d+)/.exec(getNodeVersion());
  if (match === null) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      `Unable to parse local Node.js version from '${getNodeVersion()}'.`,
    );
  }
  return match[1]!;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureEctlAbsentOrForced(
  projectRoot: string,
  force: boolean,
  confirmForce: () => Promise<boolean>,
): Promise<void> {
  if (!ectlDirExists(projectRoot)) {
    return;
  }

  if (!force) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      ".ectl/ already exists in this directory. Run `ectl terminate` if a task is active, then use `ectl init --force` to reinitialize.",
    );
  }

  const confirmed = await confirmForce();
  if (!confirmed) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      "Reinitialization cancelled.",
    );
  }

  await rm(getEctlDir(projectRoot), { recursive: true, force: true });
}

async function createEctlTree(projectRoot: string): Promise<void> {
  await mkdir(getKeysDir(projectRoot), { recursive: true });
  await mkdir(getTasksDir(projectRoot), { recursive: true });
  await mkdir(getLogsDir(projectRoot), { recursive: true });
}

async function writeEctlignoreIfMissing(
  projectRoot: string,
): Promise<boolean> {
  const path = getEctlignorePath(projectRoot);
  if (await fileExists(path)) {
    return false;
  }

  await writeFile(path, defaultEctlignoreContent(), "utf8");
  return true;
}

async function updateGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = join(projectRoot, ".gitignore");
  let content = "";

  if (await fileExists(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
  }

  const { content: updated, updated: changed } = appendEctlToGitignore(content);
  if (changed) {
    await writeFile(gitignorePath, updated, "utf8");
  }

  return changed;
}

async function provisionKeyPair(
  provisioner: AwsProvisioner,
  projectRoot: string,
  keyPairName: string,
  importKeyPath: string | undefined,
): Promise<"generated" | "imported"> {
  const privateKeyPath = getPrivateKeyPath(projectRoot);

  if (importKeyPath !== undefined) {
    const pem = await readFile(importKeyPath, "utf8");
    await writeFile(privateKeyPath, pem, { mode: 0o600 });
    await provisioner.importKeyPairFromPrivatePem(keyPairName, pem);
    return "imported";
  }

  const { privateKeyPem } = await provisioner.createKeyPair(keyPairName);
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });
  return "generated";
}

export class ProjectInitializer {
  private readonly createProvisioner: (region: string) => AwsProvisioner;
  private readonly getNodeVersion: () => string;

  constructor(deps: ProjectInitializerDeps = {}) {
    this.createProvisioner =
      deps.createProvisioner ?? ((region) => createAwsProvisioner(region));
    this.getNodeVersion = deps.getNodeVersion ?? (() => process.version);
  }

  async initialize(
    options: InitOptions,
    prompts: InitPrompts,
  ): Promise<InitResult> {
    const projectRoot = options.projectRoot;
    const force = options.force ?? false;

    await ensureEctlAbsentOrForced(
      projectRoot,
      force,
      prompts.confirmForce,
    );

    const defaultRegion = resolveDefaultRegion();
    const region =
      options.region ?? (await prompts.selectRegion(defaultRegion));

    const provisioner = this.createProvisioner(region);
    await provisioner.validateCredentials();

    let amiId: string;
    if (options.amiId !== undefined) {
      amiId = options.amiId;
    } else {
      const amiCandidates = await provisioner.listUbuntuAmis();
      amiId = await prompts.selectAmi(amiCandidates);
    }

    const defaultInstanceType = DEFAULT_ECTL_CONFIG.instanceType;
    const instanceType =
      options.instanceType ??
      (await prompts.selectInstanceType(defaultInstanceType));

    await createEctlTree(projectRoot);

    const projectSlug = deriveProjectSlug(projectRoot);
    const keyPairName = buildKeyPairName(projectSlug);
    const keySource = await provisionKeyPair(
      provisioner,
      projectRoot,
      keyPairName,
      options.importKeyPath,
    );

    const nodeVersion = getLocalNodeMajorVersion(this.getNodeVersion);

    const config: EctlConfig = {
      ...DEFAULT_ECTL_CONFIG,
      region,
      instanceType,
      amiId,
      keyPairName,
      keySource,
      nodeVersion,
      projectSlug,
    };

    const configManager = new ConfigManager(projectRoot);
    await configManager.write(config);

    const createdEctlignore = await writeEctlignoreIfMissing(projectRoot);
    const updatedGitignore = await updateGitignore(projectRoot);

    return {
      projectRoot,
      config,
      keySource,
      createdEctlignore,
      updatedGitignore,
    };
  }
}

export function createProjectInitializer(
  deps: ProjectInitializerDeps = {},
): ProjectInitializer {
  return new ProjectInitializer(deps);
}

export { DEFAULT_INSTANCE_TYPES, resolveDefaultRegion };
