import { z } from "zod";

export const taskStatusSchema = z.enum([
  "provisioning",
  "running",
  "stopped",
  "completed",
  "failed",
  "terminated",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "provisioning",
  "running",
  "stopped",
  "failed",
] as const;

export const taskStateSchema = z.object({
  taskName: z.string().min(1),
  status: taskStatusSchema,
  instanceId: z.string(),
  publicIp: z.string(),
  securityGroupId: z.string(),
  keyPairName: z.string().min(1),
  region: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastReconciledAt: z.string().datetime().optional(),
});

export type TaskState = z.infer<typeof taskStateSchema>;
