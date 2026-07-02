import { Command } from "commander";
import { createCliContext } from "./context.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLaunchCommand } from "./commands/launch.js";
import { registerPushCommand } from "./commands/push.js";
import { registerRunCommand } from "./commands/run.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerPullCommand } from "./commands/pull.js";
import { registerSshCommand } from "./commands/ssh.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerTerminateCommand } from "./commands/terminate.js";

const PACKAGE_VERSION = "0.0.0";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("ectl")
    .description("Run long-lived tasks on AWS EC2 from a project-local .ectl directory")
    .version(PACKAGE_VERSION, "-V, --version", "Show version number")
    .option("--json", "Emit machine-readable JSON output")
    .option("--verbose", "Enable verbose logging")
    .enablePositionalOptions()
    .passThroughOptions();

  const getContext = () => {
    const opts = program.opts<{ json?: boolean; verbose?: boolean }>();
    return createCliContext({
      json: opts.json ?? false,
      verbose: opts.verbose ?? false,
    });
  };

  registerInitCommand(program, getContext);
  registerLaunchCommand(program, getContext);
  registerPushCommand(program, getContext);
  registerRunCommand(program, getContext);
  registerDeployCommand(program, getContext);
  registerStatusCommand(program, getContext);
  registerLogsCommand(program, getContext);
  registerPullCommand(program, getContext);
  registerSshCommand(program, getContext);
  registerStopCommand(program, getContext);
  registerTerminateCommand(program, getContext);

  await program.parseAsync(argv);
}
