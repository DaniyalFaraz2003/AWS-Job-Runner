import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { createEc2Client } from "../../src/aws/client.js";

const ec2Mock = mockClient(EC2Client);

describe("createEc2Client verbose logging", () => {
  it("logs AWS request IDs when onVerbose is provided", async () => {
    ec2Mock.reset();
    ec2Mock.on(DescribeRegionsCommand).resolves({
      Regions: [],
      $metadata: { requestId: "req-abc-123", httpStatusCode: 200 },
    });

    const verboseLines: string[] = [];
    const client = createEc2Client({
      region: "us-east-1",
      onVerbose: (message) => verboseLines.push(message),
    });

    await client.send(new DescribeRegionsCommand({}));

    expect(verboseLines).toHaveLength(1);
    expect(verboseLines[0]).toContain("req-abc-123");
    expect(verboseLines[0]).toContain("HTTP 200");
  });

  it("does not log when onVerbose is omitted", async () => {
    ec2Mock.reset();
    ec2Mock.on(DescribeRegionsCommand).resolves({
      Regions: [],
      $metadata: { requestId: "req-silent", httpStatusCode: 200 },
    });

    const client = createEc2Client({ region: "us-east-1" });
    await client.send(new DescribeRegionsCommand({}));
  });
});
