import {
  DescribeImagesCommand,
  paginateDescribeImages,
  type EC2Client,
  type Image,
} from "@aws-sdk/client-ec2";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { wrapAwsError } from "./map-aws-error.js";

/** Canonical publisher IDs per AWS partition (Ubuntu official docs). */
const CANONICAL_OWNER_BY_PARTITION = {
  standard: "099720109477",
  govcloud: "513442679011",
  china: "837727238323",
} as const;

export type UbuntuLtsVersion = "22.04" | "24.04" | "26.04";

export interface UbuntuLtsRelease {
  readonly version: UbuntuLtsVersion;
  readonly label: string;
  readonly namePatterns: readonly string[];
  readonly ssmPaths: readonly string[];
}

/** Supported Ubuntu LTS releases for ectl init AMI picker. */
export const UBUNTU_LTS_RELEASES: readonly UbuntuLtsRelease[] = [
  {
    version: "22.04",
    label: "Ubuntu 22.04 LTS (Jammy)",
    namePatterns: [
      "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
      "ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-amd64-server-*",
    ],
    ssmPaths: [
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
      "/aws/service/canonical/ubuntu/server/jammy/stable/current/amd64/hvm/ebs-gp2/ami-id",
    ],
  },
  {
    version: "24.04",
    label: "Ubuntu 24.04 LTS (Noble)",
    namePatterns: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*",
    ],
    ssmPaths: [
      "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      "/aws/service/canonical/ubuntu/server/noble/stable/current/amd64/hvm/ebs-gp3/ami-id",
    ],
  },
  {
    version: "26.04",
    label: "Ubuntu 26.04 LTS (Resolute)",
    namePatterns: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-resolute-26.04-amd64-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-resolute-26.04-amd64-server-*",
    ],
    ssmPaths: [
      "/aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      "/aws/service/canonical/ubuntu/server/resolute/stable/current/amd64/hvm/ebs-gp3/ami-id",
    ],
  },
] as const;

const ALL_UBUNTU_NAME_PATTERNS = UBUNTU_LTS_RELEASES.flatMap(
  (release) => release.namePatterns,
);

const MAX_AMIS_PER_VERSION = 5;
const VERSION_SORT_ORDER: Record<UbuntuLtsVersion, number> = {
  "26.04": 0,
  "24.04": 1,
  "22.04": 2,
};

export interface UbuntuAmiCandidate {
  readonly amiId: string;
  readonly name: string;
  readonly creationDate: string;
  readonly ubuntuVersion: UbuntuLtsVersion;
}

export interface AmiResolverDeps {
  readonly ssmClient?: SSMClient;
}

export function getCanonicalOwnerId(region: string): string {
  if (region.startsWith("cn-")) {
    return CANONICAL_OWNER_BY_PARTITION.china;
  }
  if (region.startsWith("us-gov-")) {
    return CANONICAL_OWNER_BY_PARTITION.govcloud;
  }
  return CANONICAL_OWNER_BY_PARTITION.standard;
}

export function detectUbuntuVersion(imageName: string): UbuntuLtsVersion | undefined {
  if (imageName.includes("jammy-22.04") || imageName.includes("ubuntu-22.04")) {
    return "22.04";
  }
  if (imageName.includes("noble-24.04") || imageName.includes("ubuntu-24.04")) {
    return "24.04";
  }
  if (imageName.includes("resolute-26.04") || imageName.includes("ubuntu-26.04")) {
    return "26.04";
  }
  return undefined;
}

export function formatAmiChoiceLabel(candidate: UbuntuAmiCandidate): string {
  const date = candidate.creationDate.slice(0, 10);
  const release = UBUNTU_LTS_RELEASES.find(
    (entry) => entry.version === candidate.ubuntuVersion,
  );
  const versionLabel = release?.label ?? `Ubuntu ${candidate.ubuntuVersion} LTS`;
  const shortName = candidate.name.split("/").pop() ?? candidate.name;
  return `${versionLabel} · ${candidate.amiId} · ${shortName} · ${date}`;
}

function imageToCandidate(image: Image): UbuntuAmiCandidate | undefined {
  const amiId = image.ImageId;
  const name = image.Name;
  const creationDate = image.CreationDate;

  if (amiId === undefined || name === undefined || creationDate === undefined) {
    return undefined;
  }

  const ubuntuVersion = detectUbuntuVersion(name);
  if (ubuntuVersion === undefined) {
    return undefined;
  }

  return { amiId, name, creationDate, ubuntuVersion };
}

function sortCandidatesForPicker(
  candidates: UbuntuAmiCandidate[],
): UbuntuAmiCandidate[] {
  return [...candidates].sort((a, b) => {
    const versionDiff =
      VERSION_SORT_ORDER[a.ubuntuVersion] - VERSION_SORT_ORDER[b.ubuntuVersion];
    if (versionDiff !== 0) {
      return versionDiff;
    }
    return b.creationDate.localeCompare(a.creationDate);
  });
}

function dedupeCandidates(
  candidates: UbuntuAmiCandidate[],
): UbuntuAmiCandidate[] {
  const seen = new Set<string>();
  const unique: UbuntuAmiCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.amiId)) {
      continue;
    }
    seen.add(candidate.amiId);
    unique.push(candidate);
  }

  return unique;
}

function capPerVersion(candidates: UbuntuAmiCandidate[]): UbuntuAmiCandidate[] {
  const grouped = new Map<UbuntuLtsVersion, UbuntuAmiCandidate[]>();

  for (const release of UBUNTU_LTS_RELEASES) {
    grouped.set(release.version, []);
  }

  for (const candidate of sortCandidatesForPicker(candidates)) {
    grouped.get(candidate.ubuntuVersion)?.push(candidate);
  }

  const capped: UbuntuAmiCandidate[] = [];
  for (const release of UBUNTU_LTS_RELEASES) {
    const versionCandidates = grouped.get(release.version) ?? [];
    capped.push(...versionCandidates.slice(0, MAX_AMIS_PER_VERSION));
  }

  return sortCandidatesForPicker(capped);
}

export class AmiResolver {
  private readonly client: EC2Client;
  private readonly region: string;
  private readonly ssmClient: SSMClient;

  constructor(
    client: EC2Client,
    region: string,
    deps: AmiResolverDeps = {},
  ) {
    this.client = client;
    this.region = region;
    this.ssmClient = deps.ssmClient ?? new SSMClient({ region });
  }

  /** List recent Ubuntu 22.04 / 24.04 / 26.04 LTS AMIs for interactive init. */
  async listUbuntuAmis(): Promise<UbuntuAmiCandidate[]> {
    try {
      const fromDescribe = await this.fetchFromDescribeImages();
      let merged = dedupeCandidates(fromDescribe);

      for (const release of UBUNTU_LTS_RELEASES) {
        const hasVersion = merged.some(
          (candidate) => candidate.ubuntuVersion === release.version,
        );
        if (hasVersion) {
          continue;
        }

        const fromSsm = await this.fetchReleaseFromSsm(release);
        if (fromSsm !== undefined) {
          merged = dedupeCandidates([...merged, fromSsm]);
        }
      }

      const capped = capPerVersion(merged);
      if (capped.length > 0) {
        return capped;
      }

      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        `No Ubuntu 22.04 / 24.04 / 26.04 LTS AMIs found in ${this.region}. Check your region and EC2 permissions, or pass --ami-id.`,
      );
    } catch (error) {
      if (error instanceof EctlError) {
        throw error;
      }
      throw wrapAwsError(error, "Failed to list Ubuntu LTS AMIs");
    }
  }

  /** @deprecated Use {@link listUbuntuAmis}; kept for callers expecting 22.04-only naming. */
  async listUbuntu2204Amis(): Promise<UbuntuAmiCandidate[]> {
    return this.listUbuntuAmis();
  }

  /** Default AMI when selection is skipped (newest Ubuntu 24.04, else newest overall). */
  async resolveDefaultUbuntuAmiId(): Promise<string> {
    const candidates = await this.listUbuntuAmis();
    const preferred =
      candidates.find((candidate) => candidate.ubuntuVersion === "24.04") ??
      candidates[0];
    return preferred!.amiId;
  }

  /** @deprecated Use {@link resolveDefaultUbuntuAmiId}. */
  async resolveUbuntu2204AmiId(): Promise<string> {
    return this.resolveDefaultUbuntuAmiId();
  }

  private async fetchFromDescribeImages(): Promise<UbuntuAmiCandidate[]> {
    const ownerId = getCanonicalOwnerId(this.region);
    const paginator = paginateDescribeImages(
      { client: this.client },
      {
        Owners: [ownerId],
        Filters: [
          { Name: "name", Values: [...ALL_UBUNTU_NAME_PATTERNS] },
          { Name: "state", Values: ["available"] },
          { Name: "architecture", Values: ["x86_64"] },
        ],
      },
    );

    const candidates: UbuntuAmiCandidate[] = [];

    for await (const page of paginator) {
      for (const image of page.Images ?? []) {
        const candidate = imageToCandidate(image);
        if (candidate !== undefined) {
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  private async fetchReleaseFromSsm(
    release: UbuntuLtsRelease,
  ): Promise<UbuntuAmiCandidate | undefined> {
    for (const path of release.ssmPaths) {
      const candidate = await this.fetchSsmAmi(path, release.version);
      if (candidate !== undefined) {
        return candidate;
      }
    }
    return undefined;
  }

  private async fetchSsmAmi(
    parameterPath: string,
    ubuntuVersion: UbuntuLtsVersion,
  ): Promise<UbuntuAmiCandidate | undefined> {
    try {
      const response = await this.ssmClient.send(
        new GetParameterCommand({ Name: parameterPath }),
      );
      const amiId = response.Parameter?.Value?.trim();
      if (amiId === undefined || amiId.length === 0) {
        return undefined;
      }

      const ownerId = getCanonicalOwnerId(this.region);
      const describe = await this.client.send(
        new DescribeImagesCommand({
          ImageIds: [amiId],
          Owners: [ownerId],
        }),
      );

      const image = describe.Images?.[0];
      const candidate = image !== undefined ? imageToCandidate(image) : undefined;
      if (candidate !== undefined) {
        return candidate;
      }

      const release = UBUNTU_LTS_RELEASES.find(
        (entry) => entry.version === ubuntuVersion,
      );

      return {
        amiId,
        name: `${release?.label ?? `Ubuntu ${ubuntuVersion}`} (SSM recommended)`,
        creationDate: new Date().toISOString(),
        ubuntuVersion,
      };
    } catch {
      return undefined;
    }
  }
}
