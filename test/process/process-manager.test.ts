import { beforeEach, describe, expect, it } from "vitest";
import { BootstrapScript } from "../../src/process/bootstrap-script.js";
import {
  buildPm2LogsCommand,
  buildPm2StartCommand,
  parsePm2Jlist,
} from "../../src/process/pm2-commands.js";
import { ProcessManager } from "../../src/process/process-manager.js";
import type {
  ExecCommandOptions,
  ExecCommandResult,
  GetFileOptions,
  PutFileOptions,
  SshClient,
  SshConnectConfig,
} from "../../src/ssh/node-ssh-client.js";
import { SshManager } from "../../src/ssh/ssh-manager.js";
import { StateStore } from "../../src/state/state-store.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

class RecordingSshClient implements SshClient {
  connected = false;
  disposed = false;
  commands: string[] = [];
  private readonly responses: Map<string, ExecCommandResult>;

  constructor(responses: Map<string, ExecCommandResult>) {
    this.responses = responses;
  }

  async connect(_config: SshConnectConfig): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected && !this.disposed;
  }

  async execCommand(
    command: string,
    _options?: ExecCommandOptions,
  ): Promise<ExecCommandResult> {
    this.commands.push(command);

    for (const [prefix, result] of this.responses.entries()) {
      if (command.includes(prefix)) {
        return result;
      }
    }

    return { stdout: "", stderr: "", code: 0, signal: null };
  }

  async putFile(
    _localPath: string,
    _remotePath: string,
    _options?: PutFileOptions,
  ): Promise<void> {
    return;
  }

  async getFile(
    _remotePath: string,
    _localPath: string,
    _options?: GetFileOptions,
  ): Promise<void> {
    return;
  }

  async getDirectory(
    _remotePath: string,
    _localPath: string,
    _options?: GetFileOptions,
  ): Promise<void> {
    return;
  }

  async openShell(): Promise<void> {
    return;
  }

  dispose(): void {
    this.disposed = true;
    this.connected = false;
  }
}

async function createProject(): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "ectl-process-"));
  await mkdir(join(root, ".ectl", "tasks"), { recursive: true });
  return { root, store: new StateStore(root) };
}

describe("pm2 command builders", () => {
  it("buildPm2StartCommand runs from remoteWorkDir with bash -lc", () => {
    const command = buildPm2StartCommand(
      "default",
      "npm install && npm start",
      "/home/ubuntu/ectl-workspace",
    );

    expect(command).toContain("cd '/home/ubuntu/ectl-workspace'");
    expect(command).toContain("pm2 start --name 'default'");
    expect(command).toContain("-lc 'npm install && npm start'");
  });

  it("buildPm2LogsCommand limits lines and uses nostream", () => {
    expect(buildPm2LogsCommand("default", { lines: 50 })).toBe(
      "pm2 logs 'default' --lines 50 --nostream",
    );
  });

  it("parsePm2Jlist maps pm2 JSON output", () => {
    const stdout = JSON.stringify([
      {
        name: "default",
        pm_id: 0,
        pid: 1234,
        pm2_env: { status: "online" },
      },
    ]);

    expect(parsePm2Jlist(stdout)).toEqual([
      { name: "default", status: "online", pmId: 0, pid: 1234 },
    ]);
  });
});

describe("BootstrapScript", () => {
  it("skips install when bootstrap check succeeds", async () => {
    const client = new RecordingSshClient(
      new Map([
        ["command -v curl", { stdout: "", stderr: "", code: 0, signal: null }],
      ]),
    );
    const ssh = new SshManager({ createClient: () => client });
    await ssh.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    const bootstrap = new BootstrapScript({ ssh });
    await bootstrap.ensureReady("22");

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toContain("command -v pm2");
  });

  it("runs install when bootstrap check fails", async () => {
    const client = new RecordingSshClient(
      new Map([
        ["command -v curl", { stdout: "", stderr: "", code: 1, signal: null }],
        ["deb.nodesource.com", { stdout: "", stderr: "", code: 0, signal: null }],
      ]),
    );
    const ssh = new SshManager({ createClient: () => client });
    await ssh.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    const bootstrap = new BootstrapScript({ ssh });
    await bootstrap.ensureReady("22");

    expect(client.commands).toHaveLength(2);
    expect(client.commands[1]).toContain("deb.nodesource.com/setup_22.x");
  });
});

describe("ProcessManager", () => {
  let client: RecordingSshClient;
  let ssh: SshManager;
  let store: StateStore;

  beforeEach(async () => {
    client = new RecordingSshClient(
      new Map([
        ["command -v curl", { stdout: "", stderr: "", code: 0, signal: null }],
        ["pm2 start", { stdout: "started", stderr: "", code: 0, signal: null }],
        ["pm2 stop", { stdout: "", stderr: "", code: 0, signal: null }],
        ["pm2 jlist", {
          stdout: JSON.stringify([
            { name: "default", pm_id: 0, pid: 99, pm2_env: { status: "online" } },
          ]),
          stderr: "",
          code: 0,
          signal: null,
        }],
        ["pm2 logs", { stdout: "log line\n", stderr: "", code: 0, signal: null }],
      ]),
    );
    ssh = new SshManager({ createClient: () => client });
    await ssh.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    const project = await createProject();
    store = project.store;
  });

  it("startProcess bootstraps, starts pm2, and writes run.json", async () => {
    const manager = new ProcessManager({ ssh, stateStore: store });

    const run = await manager.startProcess({
      taskName: "default",
      command: "npm start",
      source: "flag",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      nodeVersion: "22",
    });

    expect(run.command).toBe("npm start");
    expect(run.pm2ProcessName).toBe("default");
    expect(run.source).toBe("flag");

    const persisted = await store.readRun("default");
    expect(persisted).toEqual(run);
    expect(client.commands.some((cmd) => cmd.includes("pm2 start"))).toBe(true);
  });

  it("stopProcess runs pm2 stop", async () => {
    const manager = new ProcessManager({ ssh, stateStore: store });
    await manager.stopProcess("default");

    expect(client.commands.at(-1)).toBe("pm2 stop 'default'");
  });

  it("listProcesses returns parsed pm2 data", async () => {
    const manager = new ProcessManager({ ssh, stateStore: store });
    const processes = await manager.listProcesses();

    expect(processes).toEqual([
      { name: "default", status: "online", pmId: 0, pid: 99 },
    ]);
  });

  it("getLogs returns stdout from pm2 logs", async () => {
    const manager = new ProcessManager({ ssh, stateStore: store });
    const logs = await manager.getLogs("default", { lines: 25 });

    expect(logs).toBe("log line\n");
    expect(client.commands.at(-1)).toBe(
      "pm2 logs 'default' --lines 25 --nostream",
    );
  });

  it("throws when pm2 start fails", async () => {
    client = new RecordingSshClient(
      new Map([
        ["command -v curl", { stdout: "", stderr: "", code: 0, signal: null }],
        ["pm2 start", { stdout: "", stderr: "boom", code: 1, signal: null }],
      ]),
    );
    ssh = new SshManager({ createClient: () => client });
    await ssh.connect("203.0.113.10", "/tmp/key.pem", "ubuntu");

    const manager = new ProcessManager({ ssh, stateStore: store });

    await expect(
      manager.startProcess({
        taskName: "default",
        command: "npm start",
        source: "flag",
        remoteWorkDir: "/home/ubuntu/ectl-workspace",
        nodeVersion: "22",
      }),
    ).rejects.toMatchObject({ code: ECTL_ERROR_CODES.SSH_CONNECTION_FAILED });
  });
});
