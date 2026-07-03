import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  type EC2Client,
  type Tag,
} from "@aws-sdk/client-ec2";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { wrapAwsError } from "./map-aws-error.js";

export interface CreateSecurityGroupInput {
  readonly projectSlug: string;
  readonly taskName: string;
  readonly vpcId: string;
  readonly sshCidr: string;
  readonly tags: readonly Tag[];
  readonly description?: string;
}

export interface CreateSecurityGroupResult {
  readonly securityGroupId: string;
  readonly securityGroupName: string;
}

export class SecurityGroupService {
  constructor(private readonly client: EC2Client) {}

  buildSecurityGroupName(projectSlug: string, taskName: string): string {
    return `ectl-${projectSlug}-${taskName}`;
  }

  async createTaskSecurityGroup(
    input: CreateSecurityGroupInput,
  ): Promise<CreateSecurityGroupResult> {
    const securityGroupName = this.buildSecurityGroupName(
      input.projectSlug,
      input.taskName,
    );

    try {
      const createResponse = await this.client.send(
        new CreateSecurityGroupCommand({
          GroupName: securityGroupName,
          Description:
            input.description ??
            `ectl SSH access for ${input.projectSlug}/${input.taskName}`,
          VpcId: input.vpcId,
          TagSpecifications: [
            {
              ResourceType: "security-group",
              Tags: [...input.tags],
            },
          ],
        }),
      );

      const securityGroupId = createResponse.GroupId;
      if (securityGroupId === undefined) {
        throw new Error("CreateSecurityGroup did not return a group ID.");
      }

      await this.client.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: securityGroupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: input.sshCidr }],
            },
          ],
        }),
      );

      return { securityGroupId, securityGroupName };
    } catch (error) {
      throw wrapAwsError(
        error,
        `Failed to create security group '${securityGroupName}'`,
      );
    }
  }

  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecurityGroupCommand({ GroupId: securityGroupId }),
      );
    } catch (error) {
      throw wrapAwsError(
        error,
        `Failed to delete security group '${securityGroupId}'`,
      );
    }
  }

  resolveSshCidr(options: {
    allowAnyIp: boolean;
    callerIp?: string;
  }): string {
    if (options.allowAnyIp) {
      return "0.0.0.0/0";
    }

    if (options.callerIp === undefined || options.callerIp.length === 0) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        "Caller public IP is required to restrict SSH ingress.",
      );
    }

    return `${options.callerIp}/32`;
  }
}
