import {
  CreateTagsCommand,
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceTerminated,
  type EC2Client,
  type Instance,
  type InstanceStatus,
  type Tag,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { formatElapsedMs } from "../util/format-elapsed.js";
import { findDefaultVpcContext } from "./default-vpc.js";
import { wrapAwsError } from "./map-aws-error.js";

/** UI elapsed-time refresh while waiting (every second). */
const STATUS_CHECK_HEARTBEAT_MS = 1_000;
/** How often to call DescribeInstanceStatus (avoid hammering the API). */
const STATUS_CHECK_POLL_MS = 5_000;

export interface LaunchInstanceInput {
  readonly amiId: string;
  readonly instanceType: string;
  readonly keyPairName: string;
  readonly securityGroupId: string;
  readonly tags: readonly Tag[];
  readonly onProgress?: (message: string) => void;
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

export interface WaitForInstanceStatusChecksOptions {
  readonly maxWaitTimeSeconds?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly onProgress?: (message: string) => void;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function instanceStatusChecksOk(status: InstanceStatus | undefined): boolean {
  return (
    status?.InstanceStatus?.Status === "ok" &&
    status?.SystemStatus?.Status === "ok"
  );
}

/**
 * Poll until EC2 instance + system status checks pass (console "2/2 checks passed").
 * Uses fixed 5s API polling instead of the SDK waiter (15–120s exponential backoff).
 */
export async function waitForInstanceStatusChecks(
  client: EC2Client,
  instanceId: string,
  options: WaitForInstanceStatusChecksOptions = {},
): Promise<void> {
  const maxWaitTimeSeconds =
    options.maxWaitTimeSeconds ?? DEFAULT_INSTANCE_WAIT_SECONDS;
  const pollIntervalMs = options.pollIntervalMs ?? STATUS_CHECK_POLL_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? STATUS_CHECK_HEARTBEAT_MS;
  const sleepFn = options.sleepFn ?? sleepMs;

  const deadline = Date.now() + maxWaitTimeSeconds * 1000;
  const waitStartedAt = Date.now();

  const heartbeat = options.onProgress
    ? setInterval(() => {
        options.onProgress?.(
          `Waiting for instance status checks (${formatElapsedMs(Date.now() - waitStartedAt)})…`,
        );
      }, heartbeatIntervalMs)
    : undefined;

  try {
    while (Date.now() < deadline) {
      try {
        const response = await client.send(
          new DescribeInstanceStatusCommand({
            InstanceIds: [instanceId],
            IncludeAllInstances: true,
          }),
        );

        if (instanceStatusChecksOk(response.InstanceStatuses?.[0])) {
          return;
        }
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "name" in error &&
            error.name === "InvalidInstanceID.NotFound"
          )
        ) {
          throw wrapAwsError(
            error,
            `Failed while waiting for instance '${instanceId}' status checks`,
          );
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await sleepFn(Math.min(pollIntervalMs, remainingMs));
    }

    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      `Timed out after ${String(maxWaitTimeSeconds)}s waiting for EC2 status checks on '${instanceId}'. Run \`ectl status\` or check the AWS console.`,
    );
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
  }
}

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

      input.onProgress?.(
        `Instance ${instanceId} created — waiting for status checks…`,
      );

      await waitForInstanceStatusChecks(this.client, instanceId, {
        ...(input.onProgress !== undefined
          ? { onProgress: input.onProgress }
          : {}),
      });

      input.onProgress?.("Instance status checks passed");

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
    const described = await this.tryDescribeInstance(instanceId);
    if (described === null) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        `Instance '${instanceId}' was not found in AWS.`,
      );
    }

    return described;
  }

  /** Returns null when the instance ID is unknown or no longer exists in AWS. */
  async tryDescribeInstance(instanceId: string): Promise<DescribeInstanceResult | null> {
    if (instanceId.length === 0) {
      return null;
    }

    try {
      const response = await this.client.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );

      const instance = response.Reservations?.[0]?.Instances?.[0];
      if (instance?.InstanceId === undefined) {
        return null;
      }

      return mapDescribeInstance(instance);
    } catch (error) {
      if (isInvalidInstanceIdError(error)) {
        return null;
      }
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

function isInvalidInstanceIdError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "name" in error &&
    error.name === "InvalidInstanceID.NotFound"
  );
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
  await waitForInstanceStatusChecks(client, instanceId, {
    maxWaitTimeSeconds,
  });
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
