import {
  DescribeImagesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AmiResolver,
  detectUbuntuVersion,
  formatAmiChoiceLabel,
  getCanonicalOwnerId,
} from "../../src/aws/ami-resolver.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";

const ec2Mock = mockClient(EC2Client);
const ssmMock = mockClient(SSMClient);

describe("getCanonicalOwnerId", () => {
  it("uses standard partition owner by default", () => {
    expect(getCanonicalOwnerId("us-east-1")).toBe("099720109477");
  });

  it("uses GovCloud owner for us-gov regions", () => {
    expect(getCanonicalOwnerId("us-gov-west-1")).toBe("513442679011");
  });

  it("uses China owner for cn regions", () => {
    expect(getCanonicalOwnerId("cn-north-1")).toBe("837727238323");
  });
});

describe("detectUbuntuVersion", () => {
  it("detects 22.04, 24.04, and 26.04 image names", () => {
    expect(
      detectUbuntuVersion(
        "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260601",
      ),
    ).toBe("22.04");
    expect(
      detectUbuntuVersion(
        "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260601",
      ),
    ).toBe("24.04");
    expect(
      detectUbuntuVersion(
        "ubuntu/images/hvm-ssd-gp3/ubuntu-resolute-26.04-amd64-server-20260601",
      ),
    ).toBe("26.04");
  });
});

describe("AmiResolver.listUbuntuAmis", () => {
  beforeEach(() => {
    ec2Mock.reset();
    ssmMock.reset();
  });

  function createClients(): {
    ec2Client: EC2Client;
    ssmClient: SSMClient;
  } {
    return {
      ec2Client: new EC2Client({ region: "us-east-1" }),
      ssmClient: new SSMClient({ region: "us-east-1" }),
    };
  }

  it("returns newest AMIs from DescribeImages with the correct owner", async () => {
    ec2Mock.on(DescribeImagesCommand).resolves({
      Images: [
        {
          ImageId: "ami-22-old",
          Name: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260101",
          CreationDate: "2026-01-01T00:00:00.000Z",
        },
        {
          ImageId: "ami-24-new",
          Name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260601",
          CreationDate: "2026-06-01T00:00:00.000Z",
        },
        {
          ImageId: "ami-26-new",
          Name: "ubuntu/images/hvm-ssd-gp3/ubuntu-resolute-26.04-amd64-server-20260602",
          CreationDate: "2026-06-02T00:00:00.000Z",
        },
      ],
    });

    const { ec2Client, ssmClient } = createClients();
    const resolver = new AmiResolver(ec2Client, "us-east-1", { ssmClient });

    const candidates = await resolver.listUbuntuAmis();

    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.ubuntuVersion).toBe("26.04");
    expect(candidates[1]?.ubuntuVersion).toBe("24.04");
    expect(candidates[2]?.ubuntuVersion).toBe("22.04");

    const describeCalls = ec2Mock.commandCalls(DescribeImagesCommand);
    expect(describeCalls.length).toBeGreaterThan(0);
    expect(describeCalls[0]?.args[0].input.Owners).toEqual(["099720109477"]);
  });

  it("falls back to SSM when DescribeImages returns no matches", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "ami-from-ssm" },
    });
    ec2Mock.on(DescribeImagesCommand).callsFake((command) => {
      const imageIds =
        "input" in command && command.input !== undefined
          ? (command.input as { ImageIds?: string[] }).ImageIds
          : undefined;

      if (imageIds?.includes("ami-from-ssm")) {
        return {
          Images: [
            {
              ImageId: "ami-from-ssm",
              Name: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260610",
              CreationDate: "2026-06-10T00:00:00.000Z",
            },
          ],
        };
      }

      return { Images: [] };
    });

    const { ec2Client, ssmClient } = createClients();
    const resolver = new AmiResolver(ec2Client, "us-east-1", { ssmClient });

    const candidates = await resolver.listUbuntuAmis();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.amiId).toBe("ami-from-ssm");
    expect(candidates[0]?.ubuntuVersion).toBe("22.04");
  });

  it("throws when no AMIs are found anywhere", async () => {
    ec2Mock.on(DescribeImagesCommand).resolves({ Images: [] });
    ssmMock.on(GetParameterCommand).rejects(new Error("not found"));

    const { ec2Client, ssmClient } = createClients();
    const resolver = new AmiResolver(ec2Client, "us-east-1", { ssmClient });

    await expect(resolver.listUbuntuAmis()).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.CONFIG_INVALID,
    });
  });

  it("defaults to Ubuntu 24.04 when resolving without a picker", async () => {
    ec2Mock.on(DescribeImagesCommand).resolves({
      Images: [
        {
          ImageId: "ami-26",
          Name: "ubuntu/images/hvm-ssd-gp3/ubuntu-resolute-26.04-amd64-server-20260602",
          CreationDate: "2026-06-02T00:00:00.000Z",
        },
        {
          ImageId: "ami-24",
          Name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260601",
          CreationDate: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const { ec2Client, ssmClient } = createClients();
    const resolver = new AmiResolver(ec2Client, "us-east-1", { ssmClient });

    await expect(resolver.resolveDefaultUbuntuAmiId()).resolves.toBe("ami-24");
  });
});

describe("formatAmiChoiceLabel", () => {
  it("includes version label, ami id, name, and date", () => {
    const label = formatAmiChoiceLabel({
      amiId: "ami-abc123",
      name: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260610",
      creationDate: "2026-06-10T12:00:00.000Z",
      ubuntuVersion: "22.04",
    });

    expect(label).toContain("22.04");
    expect(label).toContain("ami-abc123");
    expect(label).toContain("ubuntu-jammy-22.04-amd64-server-20260610");
    expect(label).toContain("2026-06-10");
  });
});
