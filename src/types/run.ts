import { z } from "zod";

export const taskRunSchema = z.object({
  command: z.string().min(1),
  source: z.enum(["flag", "run.sh"]),
  pm2ProcessName: z.string().min(1),
  startedAt: z.string().datetime(),
  remoteWorkDir: z.string().min(1),
});

export type TaskRun = z.infer<typeof taskRunSchema>;
