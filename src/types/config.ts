import { z } from "zod";

export const ectlConfigSchema = z.object({
  version: z.literal(1),
  region: z.string().min(1),
  instanceType: z.string().min(1),
  amiId: z.string().min(1).optional(),
  sshUser: z.string().min(1),
  remoteWorkDir: z.string().min(1),
  keyPairName: z.string().min(1),
  keySource: z.enum(["generated", "imported"]),
  nodeVersion: z.string().min(1).optional(),
  artifactPaths: z.array(z.string()).default([]),
  projectSlug: z.string().min(1),
  tags: z.record(z.string()).default({}),
});

export type EctlConfig = z.infer<typeof ectlConfigSchema>;

export const DEFAULT_ECTL_CONFIG: Omit<
  EctlConfig,
  "region" | "keyPairName" | "projectSlug"
> = {
  version: 1,
  instanceType: "t3.medium",
  sshUser: "ubuntu",
  remoteWorkDir: "/home/ubuntu/ectl-workspace",
  keySource: "generated",
  artifactPaths: [],
  tags: {},
};
