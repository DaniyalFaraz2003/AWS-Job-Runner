import type { EC2Client, Tag } from "@aws-sdk/client-ec2";
import type { EctlConfig } from "../types/config.js";
import { AmiResolver, type UbuntuAmiCandidate } from "./ami-resolver.js";
import { CallerIpDetector } from "./caller-ip-detector.js";
import { createEc2Client } from "./client.js";
import { validateAwsCredentials } from "./credentials.js";
import { findDefaultVpcContext } from "./default-vpc.js";
import {
  InstanceLifecycle,
  type DescribeInstanceResult,
  type LaunchedInstance,
} from "./instance-lifecycle.js";
import {
  KeyPairService,
  type CreateKeyPairResult,
} from "./key-pair-service.js";
import {
  SecurityGroupService,
  type CreateSecurityGroupResult,
} from "./security-group-service.js";
import { buildEctlTags } from "./tag-builder.js";

export interface AwsProvisionerDeps {
  readonly client?: EC2Client;
  readonly callerIpDetector?: CallerIpDetector;
  readonly onVerbose?: (message: string) => void;
}

export interface LaunchTaskResourcesInput {
  readonly config: EctlConfig;
  readonly taskName: string;
  readonly amiId: string;
  readonly allowAnyIp?: boolean;
  readonly callerIp?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly onProgress?: (message: string) => void;
}

export interface LaunchTaskResourcesResult {
  readonly instance: LaunchedInstance;
  readonly securityGroup: CreateSecurityGroupResult;
  readonly tags: Tag[];
}

export class AwsProvisioner {
  readonly region: string;
  readonly client: EC2Client;
  readonly amiResolver: AmiResolver;
  readonly keyPairs: KeyPairService;
  readonly securityGroups: SecurityGroupService;
  readonly instances: InstanceLifecycle;
  readonly callerIpDetector: CallerIpDetector;

  constructor(
    region: string,
    deps: AwsProvisionerDeps = {},
  ) {
    this.region = region;
    this.client =
      deps.client ??
      createEc2Client({
        region,
        ...(deps.onVerbose !== undefined ? { onVerbose: deps.onVerbose } : {}),
      });
    this.amiResolver = new AmiResolver(this.client, region);
    this.keyPairs = new KeyPairService(this.client);
    this.securityGroups = new SecurityGroupService(this.client);
    this.instances = new InstanceLifecycle(this.client);
    this.callerIpDetector = deps.callerIpDetector ?? new CallerIpDetector();
  }

  async validateCredentials(): Promise<void> {
    await validateAwsCredentials(this.client);
  }

  async listUbuntuAmis(): Promise<UbuntuAmiCandidate[]> {
    return this.amiResolver.listUbuntuAmis();
  }

  /** @deprecated Use {@link listUbuntuAmis}. */
  async listUbuntu2204Amis(): Promise<UbuntuAmiCandidate[]> {
    return this.listUbuntuAmis();
  }

  async resolveDefaultUbuntuAmiId(): Promise<string> {
    return this.amiResolver.resolveDefaultUbuntuAmiId();
  }

  /** @deprecated Use {@link resolveDefaultUbuntuAmiId}. */
  async resolveUbuntu2204AmiId(): Promise<string> {
    return this.resolveDefaultUbuntuAmiId();
  }

  async createKeyPair(keyPairName: string): Promise<CreateKeyPairResult> {
    return this.keyPairs.createKeyPair(keyPairName);
  }

  async importKeyPairFromPrivatePem(
    keyPairName: string,
    privateKeyPem: string,
  ): Promise<void> {
    await this.keyPairs.importKeyPairFromPrivatePem(keyPairName, privateKeyPem);
  }

  buildTags(
    config: EctlConfig,
    taskName: string,
    options: { createdAt?: string; createdBy?: string } = {},
  ): Tag[] {
    return buildEctlTags({
      projectSlug: config.projectSlug,
      taskName,
      extraTags: config.tags,
      ...(options.createdAt !== undefined
        ? { createdAt: options.createdAt }
        : {}),
      ...(options.createdBy !== undefined
        ? { createdBy: options.createdBy }
        : {}),
    });
  }

  async resolveSshCidr(options: {
    allowAnyIp?: boolean;
    callerIp?: string;
  }): Promise<string> {
    const allowAnyIp = options.allowAnyIp ?? false;
    const callerIp =
      options.callerIp ??
      (allowAnyIp ? undefined : await this.callerIpDetector.detectPublicIpv4());

    return this.securityGroups.resolveSshCidr({
      allowAnyIp,
      ...(callerIp !== undefined ? { callerIp } : {}),
    });
  }

  async launchTaskResources(
    input: LaunchTaskResourcesInput,
  ): Promise<LaunchTaskResourcesResult> {
    const tags = this.buildTags(input.config, input.taskName, {
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    });

    input.onProgress?.("Locating default VPC and subnet…");
    const { vpcId } = await findDefaultVpcContext(this.client);

    if (input.allowAnyIp ?? false) {
      input.onProgress?.("Configuring SSH access for 0.0.0.0/0…");
    } else {
      input.onProgress?.("Detecting your public IP for SSH access…");
    }

    const sshCidr = await this.resolveSshCidr({
      allowAnyIp: input.allowAnyIp ?? false,
      ...(input.callerIp !== undefined ? { callerIp: input.callerIp } : {}),
    });

    input.onProgress?.(
      `Creating security group (SSH ${sshCidr} on port 22)…`,
    );
    const securityGroup = await this.securityGroups.createTaskSecurityGroup({
      projectSlug: input.config.projectSlug,
      taskName: input.taskName,
      vpcId,
      sshCidr,
      tags,
    });

    input.onProgress?.(
      `Launching EC2 instance (${input.config.instanceType}, ${input.amiId})…`,
    );
    const instance = await this.instances.launchInstance({
      amiId: input.amiId,
      instanceType: input.config.instanceType,
      keyPairName: input.config.keyPairName,
      securityGroupId: securityGroup.securityGroupId,
      tags,
      ...(input.onProgress !== undefined
        ? { onProgress: input.onProgress }
        : {}),
    });

    input.onProgress?.(`Public IP assigned: ${instance.publicIp}`);

    return { instance, securityGroup, tags };
  }

  async describeInstance(instanceId: string): Promise<DescribeInstanceResult> {
    return this.instances.describeInstance(instanceId);
  }

  async tryDescribeInstance(instanceId: string): Promise<DescribeInstanceResult | null> {
    return this.instances.tryDescribeInstance(instanceId);
  }

  async securityGroupExists(securityGroupId: string): Promise<boolean> {
    return this.securityGroups.securityGroupExists(securityGroupId);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    await this.instances.terminateInstance(instanceId);
  }

  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    await this.securityGroups.deleteSecurityGroup(securityGroupId);
  }
}

export function createAwsProvisioner(
  region: string,
  deps: AwsProvisionerDeps = {},
): AwsProvisioner {
  return new AwsProvisioner(region, deps);
}

export function createAwsProvisionerForConfig(
  config: EctlConfig,
  deps: AwsProvisionerDeps = {},
): AwsProvisioner {
  return createAwsProvisioner(config.region, deps);
}
