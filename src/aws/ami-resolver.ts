import {
  paginateDescribeImages,
  type EC2Client,
  type Image,
} from "@aws-sdk/client-ec2";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { wrapAwsError } from "./map-aws-error.js";

/** Canonical AWS account ID for official Ubuntu AMIs. */
const CANONICAL_OWNER_ID = "099720109479";

const UBUNTU_2204_NAME_PATTERN =
  "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*";

export class AmiResolver {
  constructor(private readonly client: EC2Client) {}

  /** Resolve latest Ubuntu 22.04 LTS x86_64 AMI in the client's region (FR-INIT-10). */
  async resolveUbuntu2204AmiId(): Promise<string> {
    try {
      const paginator = paginateDescribeImages(
        { client: this.client },
        {
          Owners: [CANONICAL_OWNER_ID],
          Filters: [
            { Name: "name", Values: [UBUNTU_2204_NAME_PATTERN] },
            { Name: "state", Values: ["available"] },
            { Name: "architecture", Values: ["x86_64"] },
          ],
        },
      );

      let latest: Image | undefined;

      for await (const page of paginator) {
        for (const image of page.Images ?? []) {
          if (latest === undefined) {
            latest = image;
            continue;
          }

          const candidateDate = image.CreationDate ?? "";
          const latestDate = latest.CreationDate ?? "";
          if (candidateDate > latestDate) {
            latest = image;
          }
        }
      }

      const amiId = latest?.ImageId;
      if (amiId === undefined) {
        throw new EctlError(
          ECTL_ERROR_CODES.CONFIG_INVALID,
          "No Ubuntu 22.04 LTS AMI found in this region. Set amiId in .ectl/config.json.",
        );
      }

      return amiId;
    } catch (error) {
      if (error instanceof EctlError) {
        throw error;
      }
      throw wrapAwsError(error, "Failed to resolve Ubuntu 22.04 AMI");
    }
  }
}
