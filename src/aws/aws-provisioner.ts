import type { EC2Client, Tag } from "@aws-sdk/client-ec2";
import type { EctlConfig } from "../types/config.js";
import { AmiResolver } from "./ami-resolver.js";
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
}

export interface LaunchTaskResourcesInput {
  readonly config: EctlConfig;
  readonly taskName: string;
  readonly amiId: string;
  readonly allowAnyIp?: boolean;
  readonly callerIp?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
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
    this.client = deps.client ?? createEc2Client({ region });
    this.amiResolver = new AmiResolver(this.client);
    this.keyPairs = new KeyPairService(this.client);
    this.securityGroups = new SecurityGroupService(this.client);
    this.instances = new InstanceLifecycle(this.client);
    this.callerIpDetector = deps.callerIpDetector ?? new CallerIpDetector();
  }

  async validateCredentials(): Promise<void> {
    await validateAwsCredentials(this.client);
  }

  async resolveUbuntu2204AmiId(): Promise<string> {
    return this.amiResolver.resolveUbuntu2204AmiId();
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

    const { vpcId } = await findDefaultVpcContext(this.client);
    const sshCidr = await this.resolveSshCidr({
      allowAnyIp: input.allowAnyIp ?? false,
      ...(input.callerIp !== undefined ? { callerIp: input.callerIp } : {}),
    });

    const securityGroup = await this.securityGroups.createTaskSecurityGroup({
      projectSlug: input.config.projectSlug,
      taskName: input.taskName,
      vpcId,
      sshCidr,
      tags,
    });

    const instance = await this.instances.launchInstance({
      amiId: input.amiId,
      instanceType: input.config.instanceType,
      keyPairName: input.config.keyPairName,
      securityGroupId: securityGroup.securityGroupId,
      tags,
    });

    return { instance, securityGroup, tags };
  }

  async describeInstance(instanceId: string): Promise<DescribeInstanceResult> {
    return this.instances.describeInstance(instanceId);
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
