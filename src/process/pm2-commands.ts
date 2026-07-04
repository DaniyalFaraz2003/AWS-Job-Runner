import { shellQuote } from "../transfer/remote-paths.js";

export interface Pm2ProcessInfo {
  readonly name: string;
  readonly status: string;
  readonly pmId: number;
  readonly pid: number | null;
}

export function buildPm2StartCommand(
  processName: string,
  command: string,
  remoteWorkDir: string,
): string {
  const workDir = shellQuote(remoteWorkDir);
  const name = shellQuote(processName);
  const cmd = shellQuote(command);

  return [
    `cd ${workDir}`,
    `pm2 delete ${name} 2>/dev/null || true`,
    `pm2 start --name ${name} --interpreter bash -- -lc ${cmd}`,
  ].join(" && ");
}

export function buildPm2StopCommand(processName: string): string {
  return `pm2 stop ${shellQuote(processName)}`;
}

export function buildPm2JlistCommand(): string {
  return "pm2 jlist";
}

export function buildPm2LogsCommand(
  processName: string,
  options: { lines?: number } = {},
): string {
  const name = shellQuote(processName);
  const lines = options.lines ?? 100;
  return `pm2 logs ${name} --lines ${String(lines)} --nostream`;
}

export function buildPm2FollowLogsCommand(
  processName: string,
  options: { lines?: number } = {},
): string {
  const name = shellQuote(processName);
  const lines = options.lines ?? 100;
  return `pm2 logs ${name} --lines ${String(lines)}`;
}

export function parsePm2Jlist(stdout: string): Pm2ProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const processes: Pm2ProcessInfo[] = [];

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = record.name;
    const pmId = record.pm_id;
    const monit = record.monit;
    const pm2Env = record.pm2_env;

    if (typeof name !== "string" || typeof pmId !== "number") {
      continue;
    }

    let pid: number | null = null;
    if (typeof record.pid === "number") {
      pid = record.pid;
    }

    let status = "unknown";
    if (
      typeof pm2Env === "object" &&
      pm2Env !== null &&
      typeof (pm2Env as Record<string, unknown>).status === "string"
    ) {
      status = (pm2Env as Record<string, unknown>).status as string;
    } else if (
      typeof monit === "object" &&
      monit !== null &&
      typeof (monit as Record<string, unknown>).status === "string"
    ) {
      status = (monit as Record<string, unknown>).status as string;
    }

    processes.push({ name, status, pmId, pid });
  }

  return processes;
}
