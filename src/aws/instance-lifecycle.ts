import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceStatusOk,
  waitUntilInstanceTerminated,
  type EC2Client,
  type Instance,
  type Tag,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { findDefaultVpcContext } from "./default-vpc.js";
import { wrapAwsError } from "./map-aws-error.js";

export interface LaunchInstanceInput {
  readonly amiId: string;
  readonly instanceType: string;
  readonly keyPairName: string;
  readonly securityGroupId: string;
  readonly tags: readonly Tag[];
}

export interface LaunchedInstance {
  readonly instanceId: string;
  readonly publicIp: string;
}

export interface DescribeInstanceResult {
  readonly instanceId: string;
  readonly stateName: string | undefined;
  readonly publicIp: string;
  readonly securityGroupIds: readonly string[];
}

const DEFAULT_INSTANCE_WAIT_SECONDS = 600;
const DEFAULT_TERMINATE_WAIT_SECONDS = 600;

export class InstanceLifecycle {
  constructor(private readonly client: EC2Client) {}

  async launchInstance(input: LaunchInstanceInput): Promise<LaunchedInstance> {
    try {
      const { subnetId } = await findDefaultVpcContext(this.client);

      const runResponse = await this.client.send(
        new RunInstancesCommand({
          ImageId: input.amiId,
          InstanceType: input.instanceType as _InstanceType,
          MinCount: 1,
          MaxCount: 1,
          KeyName: input.keyPairName,
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [...input.tags],
            },
          ],
          NetworkInterfaces: [
            {
              DeviceIndex: 0,
              SubnetId: subnetId,
              Groups: [input.securityGroupId],
              AssociatePublicIpAddress: true,
            },
          ],
        }),
      );

      const instance = runResponse.Instances?.[0];
      const instanceId = instance?.InstanceId;
      if (instanceId === undefined) {
        throw new Error("RunInstances did not return an instance ID.");
      }

      await waitUntilInstanceStatusOk(
        { client: this.client, maxWaitTime: DEFAULT_INSTANCE_WAIT_SECONDS },
        { InstanceIds: [instanceId] },
      );

      const described = await this.describeInstance(instanceId);
      if (described.publicIp.length === 0) {
        throw new EctlError(
          ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP,
          "EC2 instance has no public IP. Check default VPC subnet auto-assign public IP settings.",
        );
      }

      return {
        instanceId,
        publicIp: described.publicIp,
      };
    } catch (error) {
      if (error instanceof EctlError) {
        throw error;
      }
      throw wrapAwsError(error, "Failed to launch EC2 instance");
    }
  }

  async describeInstance(instanceId: string): Promise<DescribeInstanceResult> {
    try {
      const response = await this.client.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );

      const instance = response.Reservations?.[0]?.Instances?.[0];
      if (instance?.InstanceId === undefined) {
        throw new EctlError(
          ECTL_ERROR_CODES.CONFIG_INVALID,
          `Instance '${instanceId}' was not found in AWS.`,
        );
      }

      return mapDescribeInstance(instance);
    } catch (error) {
      if (error instanceof EctlError) {
        throw error;
      }
      throw wrapAwsError(error, `Failed to describe instance '${instanceId}'`);
    }
  }

  async terminateInstance(instanceId: string): Promise<void> {
    try {
      await this.client.send(
        new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
      );

      await waitUntilInstanceTerminated(
        { client: this.client, maxWaitTime: DEFAULT_TERMINATE_WAIT_SECONDS },
        { InstanceIds: [instanceId] },
      );
    } catch (error) {
      throw wrapAwsError(
        error,
        `Failed to terminate instance '${instanceId}'`,
      );
    }
  }

  async tagResources(
    resourceIds: readonly string[],
    tags: readonly Tag[],
  ): Promise<void> {
    if (resourceIds.length === 0 || tags.length === 0) {
      return;
    }

    try {
      await this.client.send(
        new CreateTagsCommand({
          Resources: [...resourceIds],
          Tags: [...tags],
        }),
      );
    } catch (error) {
      throw wrapAwsError(error, "Failed to tag AWS resources");
    }
  }
}

function mapDescribeInstance(instance: Instance): DescribeInstanceResult {
  const securityGroupIds =
    instance.SecurityGroups?.flatMap((group) =>
      group.GroupId !== undefined ? [group.GroupId] : [],
    ) ?? [];

  return {
    instanceId: instance.InstanceId ?? "",
    stateName: instance.State?.Name,
    publicIp: instance.PublicIpAddress ?? "",
    securityGroupIds,
  };
}

export async function waitForInstanceRunning(
  client: EC2Client,
  instanceId: string,
  maxWaitTimeSeconds = DEFAULT_INSTANCE_WAIT_SECONDS,
): Promise<void> {
  await waitUntilInstanceStatusOk(
    { client, maxWaitTime: maxWaitTimeSeconds },
    { InstanceIds: [instanceId] },
  );
}

export async function waitForInstanceTerminated(
  client: EC2Client,
  instanceId: string,
  maxWaitTimeSeconds = DEFAULT_TERMINATE_WAIT_SECONDS,
): Promise<void> {
  await waitUntilInstanceTerminated(
    { client, maxWaitTime: maxWaitTimeSeconds },
    { InstanceIds: [instanceId] },
  );
}
