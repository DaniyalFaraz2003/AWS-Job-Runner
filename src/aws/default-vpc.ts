import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { wrapAwsError } from "./map-aws-error.js";

export interface DefaultVpcContext {
  readonly vpcId: string;
  readonly subnetId: string;
}

export async function findDefaultVpcContext(
  client: EC2Client,
): Promise<DefaultVpcContext> {
  try {
    const vpcResponse = await client.send(
      new DescribeVpcsCommand({
        Filters: [{ Name: "isDefault", Values: ["true"] }],
      }),
    );

    const vpcId = vpcResponse.Vpcs?.[0]?.VpcId;
    if (vpcId === undefined) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        "No default VPC found in this region. ectl v1 requires a default VPC with a public subnet.",
      );
    }

    const preferredSubnetResponse = await client.send(
      new DescribeSubnetsCommand({
        Filters: [
          { Name: "vpc-id", Values: [vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      }),
    );

    let subnetId = preferredSubnetResponse.Subnets?.[0]?.SubnetId;

    if (subnetId === undefined) {
      const fallbackSubnetResponse = await client.send(
        new DescribeSubnetsCommand({
          Filters: [{ Name: "vpc-id", Values: [vpcId] }],
        }),
      );
      subnetId = fallbackSubnetResponse.Subnets?.[0]?.SubnetId;
    }

    if (subnetId === undefined) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        "Default VPC has no subnets. Check your AWS account networking setup.",
      );
    }

    return { vpcId, subnetId };
  } catch (error) {
    if (error instanceof EctlError) {
      throw error;
    }
    throw wrapAwsError(error, "Failed to locate default VPC");
  }
}
