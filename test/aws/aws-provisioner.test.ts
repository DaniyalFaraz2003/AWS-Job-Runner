import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AwsProvisioner } from "../../src/aws/aws-provisioner.js";
import type { EctlConfig } from "../../src/types/config.js";

const ec2Mock = mockClient(EC2Client);

const config: EctlConfig = {
  version: 1,
  region: "us-east-1",
  instanceType: "t3.medium",
  sshUser: "ubuntu",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
  keyPairName: "ectl-demo-key",
  keySource: "generated",
  artifactPaths: [],
  projectSlug: "demo",
  tags: { Team: "platform" },
};

describe("AwsProvisioner.launchTaskResources", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("creates security group and launches instance with tags", async () => {
    ec2Mock.on(DescribeVpcsCommand).resolves({
      Vpcs: [{ VpcId: "vpc-default" }],
    });
    ec2Mock.on(DescribeSubnetsCommand).resolves({
      Subnets: [{ SubnetId: "subnet-default" }],
    });
    ec2Mock.on(CreateSecurityGroupCommand).resolves({
      GroupId: "sg-created",
    });
    ec2Mock.on(AuthorizeSecurityGroupIngressCommand).resolves({});
    ec2Mock.on(RunInstancesCommand).resolves({
      Instances: [{ InstanceId: "i-launched" }],
    });
    ec2Mock.on(DescribeInstanceStatusCommand).resolves({
      InstanceStatuses: [
        {
          InstanceStatus: { Status: "ok" },
          SystemStatus: { Status: "ok" },
        },
      ],
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-launched",
              PublicIpAddress: "203.0.113.10",
              State: { Name: "running" },
              SecurityGroups: [{ GroupId: "sg-created" }],
            },
          ],
        },
      ],
    });

    const provisioner = new AwsProvisioner("us-east-1", {
      client: ec2Mock as unknown as EC2Client,
      callerIpDetector: {
        detectPublicIpv4: async () => "198.51.100.25",
      },
    });

    const result = await provisioner.launchTaskResources({
      config,
      taskName: "default",
      amiId: "ami-ubuntu2204",
      callerIp: "198.51.100.25",
      createdAt: "2026-07-03T12:00:00.000Z",
      createdBy: "tester",
    });

    expect(result.securityGroup.securityGroupId).toBe("sg-created");
    expect(result.instance.instanceId).toBe("i-launched");
    expect(result.instance.publicIp).toBe("203.0.113.10");
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { Key: "ectl:project", Value: "demo" },
        { Key: "ectl:task", Value: "default" },
        { Key: "Team", Value: "platform" },
      ]),
    );

    const ingressCalls = ec2Mock.commandCalls(
      AuthorizeSecurityGroupIngressCommand,
    );
    expect(ingressCalls[0]?.args[0].input.IpPermissions?.[0]?.IpRanges?.[0]
      ?.CidrIp).toBe("198.51.100.25/32");
  });
});

describe("AwsProvisioner.validateCredentials", () => {
  beforeEach(() => {
    ec2Mock.reset();
  });

  it("maps auth failures to AWS_CREDENTIALS_INVALID", async () => {
    ec2Mock.onAnyCommand().rejects({
      name: "UnauthorizedOperation",
      message: "not authorized",
    });

    const provisioner = new AwsProvisioner("us-east-1", {
      client: ec2Mock as unknown as EC2Client,
    });

    await expect(provisioner.validateCredentials()).rejects.toMatchObject({
      code: "AWS_CREDENTIALS_INVALID",
    });
  });
});
