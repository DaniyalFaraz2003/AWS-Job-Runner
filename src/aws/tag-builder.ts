import { userInfo } from "node:os";
import type { Tag } from "@aws-sdk/client-ec2";

export interface RequiredEctlTagsInput {
  readonly projectSlug: string;
  readonly taskName: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly extraTags?: Readonly<Record<string, string>>;
}

function resolveCreatedBy(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const envUser = process.env.USERNAME ?? process.env.USER;
  if (envUser !== undefined && envUser.length > 0) {
    return envUser;
  }

  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/** Build required ectl resource tags plus optional config tags (SRS §9.1). */
export function buildEctlTags(input: RequiredEctlTagsInput): Tag[] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const createdBy = resolveCreatedBy(input.createdBy);

  const tags: Tag[] = [
    { Key: "ectl:project", Value: input.projectSlug },
    { Key: "ectl:task", Value: input.taskName },
    { Key: "ectl:created-at", Value: createdAt },
    { Key: "ectl:created-by", Value: createdBy },
  ];

  if (input.extraTags !== undefined) {
    for (const [key, value] of Object.entries(input.extraTags)) {
      tags.push({ Key: key, Value: value });
    }
  }

  return tags;
}

export function tagsToRecord(tags: readonly Tag[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const tag of tags) {
    if (tag.Key !== undefined && tag.Value !== undefined) {
      record[tag.Key] = tag.Value;
    }
  }
  return record;
}
