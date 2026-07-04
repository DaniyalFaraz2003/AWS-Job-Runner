import {
  DescribeInstanceStatusCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { waitForInstanceStatusChecks } from "../../src/aws/instance-lifecycle.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";

const ec2Mock = mockClient(EC2Client);

describe("waitForInstanceStatusChecks", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("returns when instance and system status are ok", async () => {
    ec2Mock.on(DescribeInstanceStatusCommand).resolves({
      InstanceStatuses: [
        {
          InstanceStatus: { Status: "ok" },
          SystemStatus: { Status: "ok" },
        },
      ],
    });

    await expect(
      waitForInstanceStatusChecks(ec2Mock as unknown as EC2Client, "i-test"),
    ).resolves.toBeUndefined();

    const call = ec2Mock.commandCalls(DescribeInstanceStatusCommand)[0]?.args[0]
      .input;
    expect(call?.IncludeAllInstances).toBe(true);
    expect(call?.InstanceIds).toEqual(["i-test"]);
  });

  it("polls until status checks pass", async () => {
    ec2Mock
      .on(DescribeInstanceStatusCommand)
      .resolvesOnce({
        InstanceStatuses: [
          {
            InstanceStatus: { Status: "initializing" },
            SystemStatus: { Status: "initializing" },
          },
        ],
      })
      .resolvesOnce({
        InstanceStatuses: [
          {
            InstanceStatus: { Status: "ok" },
            SystemStatus: { Status: "ok" },
          },
        ],
      });

    await waitForInstanceStatusChecks(ec2Mock as unknown as EC2Client, "i-test", {
      pollIntervalMs: 1,
      heartbeatIntervalMs: 1_000,
      sleepFn: async () => undefined,
    });

    expect(ec2Mock.commandCalls(DescribeInstanceStatusCommand)).toHaveLength(2);
  });

  it("times out when the deadline is reached", async () => {
    ec2Mock.on(DescribeInstanceStatusCommand).resolves({
      InstanceStatuses: [
        {
          InstanceStatus: { Status: "initializing" },
          SystemStatus: { Status: "initializing" },
        },
      ],
    });

    await expect(
      waitForInstanceStatusChecks(ec2Mock as unknown as EC2Client, "i-test", {
        maxWaitTimeSeconds: 0,
        sleepFn: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.CONFIG_INVALID,
    });
  });
});
