import { DescribeRegionsCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { wrapAwsError } from "./map-aws-error.js";

export async function validateAwsCredentials(client: EC2Client): Promise<void> {
  try {
    await client.send(new DescribeRegionsCommand({ AllRegions: false }));
  } catch (error) {
    throw wrapAwsError(error, "Failed to validate AWS credentials");
  }
}
