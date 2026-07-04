# AWS Job Runner - ectl

**ectl** is a project-local command-line tool that runs long-lived jobs on Amazon EC2. Think of it like **git for cloud tasks**: run `ectl init` once in your project folder, and everything ectl needs — configuration, SSH keys, instance state, and downloaded logs — lives in a `.ectl/` directory beside your code. Nothing is stored in a global config directory.

Instead of manually clicking through the AWS Console (launch instance → upload files → install dependencies → start your process → download results → terminate), ectl automates the full lifecycle with a handful of commands.

---



## Table of contents

- [What ectl does](#what-ectl-does)
- [Requirements](#requirements)
- [AWS setup and credentials](#aws-setup-and-credentials)
- [Installation](#installation)
- [Core concepts](#core-concepts)
- [Quickstart](#quickstart)
- [Project configuration](#project-configuration)
- [Command reference](#command-reference)
  - [Global flags](#global-flags)
  - `[ectl init](#ectl-init)`
  - `[ectl launch](#ectl-launch)`
  - `[ectl push](#ectl-push)`
  - `[ectl run](#ectl-run)`
  - `[ectl deploy](#ectl-deploy)`
  - `[ectl status](#ectl-status)`
  - `[ectl logs](#ectl-logs)`
  - `[ectl pull](#ectl-pull)`
  - `[ectl ssh](#ectl-ssh)`
  - `[ectl stop](#ectl-stop)`
  - `[ectl terminate](#ectl-terminate)`
- [Typical workflows](#typical-workflows)
- [JSON output (scripting)](#json-output-scripting)
- [Security notes](#security-notes)
- [Common errors and recovery](#common-errors-and-recovery)
- [Development scripts](#development-scripts)
- [Further documentation](#further-documentation)
- [License](#license)

---



## What ectl does

When you run a batch job, build pipeline, or any long-running process on EC2, you normally repeat the same steps every time:

1. Create an EC2 instance and open SSH access
2. Copy your project files to the instance
3. Install Node.js, dependencies, and a process manager (pm2)
4. Start your command and monitor logs
5. Download output files when finished
6. Terminate the instance so you stop paying for it

**ectl wraps all of that into one workflow.** You stay in your project directory on Windows PowerShell, run ectl commands, and the tool talks to AWS and your remote instance over SSH — no AWS CLI required, and no manual key-permission fixes on Windows.

Each project supports **one active task at a time** (v1). The default task name is `default`.

---



## Requirements


| Requirement          | Details                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**          | Version **22 or newer** (matches the remote Node version ectl installs)                                                      |
| **Operating system** | **Windows PowerShell** (primary v1 target)                                                                                   |
| **AWS account**      | With permissions to manage EC2 (see [AWS setup](#aws-setup-and-credentials))                                                 |
| **Default VPC**      | Your AWS account must have a **default VPC** with a public subnet and auto-assign public IP enabled                          |
| **Internet access**  | Your machine needs outbound HTTPS to AWS APIs; the EC2 instance needs outbound internet for bootstrap (Node/npm/pm2 install) |


ectl does **not** require the AWS CLI to be installed. It uses the AWS SDK for JavaScript v3 internally.

---



## AWS setup and credentials



### How ectl authenticates

ectl uses the **standard AWS SDK credential provider chain**. It never stores AWS access keys inside `.ectl/`. Credentials are resolved in this order:

1. **Environment variables** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`
2. **Shared credentials file** — `%USERPROFILE%\.aws\credentials` on Windows
3. **Config file / profiles** — `%USERPROFILE%\.aws\config` (used with `AWS_PROFILE`)
4. **SSO and assumed roles** — via named profiles in your AWS config

During `ectl init`, ectl validates credentials by calling EC2 `DescribeRegions`. If credentials are missing or invalid, init fails with a clear error.

### Option A — Environment variables (quick test)

In PowerShell, set credentials for the current session:

```powershell
$env:AWS_ACCESS_KEY_ID = "AKIA..."
$env:AWS_SECRET_ACCESS_KEY = "your-secret-key"
$env:AWS_REGION = "us-east-1"   # optional; init wizard also asks for region
```

For temporary credentials (STS / assumed role), also set:

```powershell
$env:AWS_SESSION_TOKEN = "your-session-token"
```



### Option B — AWS credentials file (recommended for daily use)

1. Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (optional but convenient for setup).
2. Run `aws configure` and enter your access key, secret key, and default region.
3. This creates `%USERPROFILE%\.aws\credentials` and `%USERPROFILE%\.aws\config`.

To use a named profile:

```powershell
$env:AWS_PROFILE = "my-profile"
ectl init
```

Or set it permanently in your PowerShell profile.

### Option C — AWS IAM Identity Center (SSO)

If your organization uses SSO:

```powershell
aws configure sso
aws sso login --profile my-sso-profile
$env:AWS_PROFILE = "my-sso-profile"
ectl init
```



### Required IAM permissions

ectl needs broad EC2 permissions in v1. At minimum, your IAM user or role should allow:


| Action                                                                                    | Used for                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `ec2:DescribeRegions`                                                                     | Validate credentials during init        |
| `ec2:CreateKeyPair`, `ec2:ImportKeyPair`                                                  | SSH key management                      |
| `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`, `ec2:DeleteSecurityGroup` | SSH firewall rules                      |
| `ec2:DescribeImages`                                                                      | Resolve Ubuntu LTS AMI                  |
| `ec2:RunInstances`, `ec2:TerminateInstances`                                              | Launch and tear down instances          |
| `ec2:DescribeInstances`                                                                   | Status reconciliation, public IP lookup |
| `ec2:CreateTags`                                                                          | Tag instances and security groups       |


For development, an administrator or PowerUser policy is typically sufficient. For production, scope policies to the default VPC and tag-based conditions.

### Default VPC requirement

ectl launches instances in your account's **default VPC** with a **public IP**. If your account has no default VPC, or subnets do not auto-assign public IPs, `ectl launch` and `ectl deploy` will fail. Create or restore a default VPC in the AWS Console or via CLI before using ectl.

---



## Installation



### From npm (recommended)

```powershell
npm install -g ectl
```

Verify:

```powershell
ectl --version
ectl --help
```



### From source

```powershell
git clone https://github.com/DaniyalFaraz2003/AWS-Job-Runner.git
cd AWS-Job-Runner
npm install
npm run build
npm link   # optional: expose `ectl` globally from your clone
```

---



## Core concepts



### Project-local `.ectl/` directory

After `ectl init`, your project contains:

```
my-project/
├── .ectl/
│   ├── config.json          # Region, instance type, AMI, artifact paths, etc.
│   ├── keys/
│   │   └── ectl-key.pem     # Private SSH key (never commit this)
│   ├── tasks/
│   │   └── default/         # One folder per task name
│   │       ├── state.json   # Instance ID, IP, status, security group
│   │       └── run.json     # Command that was run, pm2 process name
│   ├── logs/                # Default destination for `ectl pull` downloads
│   └── run.sh               # Optional default command script
├── .ectlignore              # Files excluded from upload (like .gitignore)
└── .gitignore               # ectl init appends `.ectl/` if missing
```



### Task lifecycle


| Status         | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `provisioning` | Instance is being created or waiting for status checks     |
| `running`      | Instance is up and the pm2 process is (or was) started     |
| `stopped`      | Instance is up but pm2 process was stopped via `ectl stop` |
| `failed`       | Something went wrong (e.g. deploy partial failure)         |
| `completed`    | Task finished successfully (reserved for future use)       |
| `terminated`   | Instance destroyed; safe to launch again                   |


**Active** statuses (`provisioning`, `running`, `stopped`, `failed`) block new `launch` or `deploy` until you run `ectl terminate`.

### Run command resolution

When starting a process (`ectl run` or `ectl deploy`), ectl needs a shell command:

1. `--run "<command>"` **flag** — highest priority; runs the command you pass on the command line
2. `.ectl/run.sh` — used if no `--run` flag is provided
3. **Error** — if neither exists, ectl fails with instructions to add one

The remote instance runs your command under **pm2** so it survives SSH disconnects.

### Upload exclusions

`ectl push` (and `ectl deploy`) zip your project and upload it. Patterns in `.ectlignore` are excluded — same syntax as `.gitignore`. Default patterns exclude `node_modules/`, `.git/`, `.ectl/`, `dist/`, etc.

---



## Quickstart

```powershell
cd C:\Projects\my-batch-job

# 1. One-time project setup (interactive wizard)
ectl init
# Wizard prompts: AWS region, instance type, Ubuntu AMI

# 2. Optional: tell ectl what to download when the job finishes
# Edit .ectl/config.json → "artifactPaths": ["output/", "logs/"]

# 3. Optional: default run script instead of passing --run every time
# Create .ectl/run.sh with contents like:
#   npm install && npm start

# 4. Full happy path — launch, upload, and run in one step
ectl deploy --run "npm install && npm run build"

# 5. Monitor
ectl status
ectl logs default --follow

# 6. Retrieve output files (requires artifactPaths in config or --paths)
ectl pull

# 7. Cleanup (keeps SSH key pair for the next launch)
ectl terminate
```



### Step-by-step (debug-friendly)

Use individual commands when you want to inspect each phase:

```powershell
ectl launch          # Create EC2 instance + security group
ectl push            # Upload project zip via SFTP
ectl run --run "npm install && npm start"
ectl status          # Reconcile local state with AWS
ectl logs default --follow
ectl ssh             # Interactive shell on the instance
ectl stop            # Stop pm2 process, keep instance running
ectl terminate       # Destroy instance and security group
```

---



## Project configuration



### `.ectl/config.json`

Written by `ectl init`. Key fields:


| Field           | Description                                                                         |
| --------------- | ----------------------------------------------------------------------------------- |
| `region`        | AWS region for all resources (e.g. `us-east-1`)                                     |
| `instanceType`  | EC2 instance type (default `t3.medium`)                                             |
| `amiId`         | Ubuntu LTS AMI ID (auto-resolved during init if not set)                            |
| `sshUser`       | SSH login user (default `ubuntu`)                                                   |
| `remoteWorkDir` | Remote directory for project files (default `/home/ubuntu/ectl-workspace`)          |
| `keyPairName`   | AWS EC2 key pair name                                                               |
| `keySource`     | `"generated"` or `"imported"`                                                       |
| `nodeVersion`   | Node.js major version to install remotely (from your local Node at init)            |
| `artifactPaths` | Remote paths to download with `ectl pull` (relative to `remoteWorkDir` or absolute) |
| `projectSlug`   | Derived from your folder name; used in AWS resource names and tags                  |
| `tags`          | Optional extra AWS tags merged with required `ectl:*` tags                          |


Example snippet:

```json
{
  "version": 1,
  "region": "us-east-1",
  "instanceType": "t3.medium",
  "artifactPaths": ["output/", "logs/run.log"],
  "remoteWorkDir": "/home/ubuntu/ectl-workspace"
}
```



### `.ectlignore`

Default patterns created by init:

```
node_modules/
.git/
.ectl/
dist/
build/
.next/
coverage/
```

Add project-specific patterns (e.g. `.env`, `tmp/`, `*.log`). **Important:** `.env` is **not** excluded by default. Add it manually if you must not upload secrets.

### `.ectl/run.sh` (optional)

Bash script executed on the remote instance from `remoteWorkDir`:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm install
npm run build
npm start
```

Used automatically when you omit `--run`.

---



## Command reference

Every command supports `--help` for built-in usage text:

```powershell
ectl --help
ectl deploy --help
ectl init --help
```

Flags can be placed **before or after** the subcommand (Commander's pass-through options), and most commands accept `--json` and `--verbose` either globally or per-command:

```powershell
ectl --json status
ectl status --json
```

Both work.

---



### Global flags

These apply to the root `ectl` program and are inherited by subcommands (subcommands also declare their own copies for convenience).


| Flag        | Short | Description                                                                                                                                                          |
| ----------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version` | `-V`  | Print the ectl version number and exit                                                                                                                               |
| `--help`    | `-h`  | Show help for ectl or a specific subcommand                                                                                                                          |
| `--json`    |       | Emit structured JSON to stdout (see [JSON output](#json-output-scripting)). Suppresses decorative human output. Some interactive features are disabled in JSON mode. |
| `--verbose` |       | Enable debug logging to stderr, including AWS request IDs where available                                                                                            |


**JSON mode caveats:**


| Command                             | Behavior with `--json`                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| `ectl ssh`                          | **Not supported** — interactive SSH cannot produce JSON output       |
| `ectl logs --follow`                | **Not supported** — streaming and JSON are mutually exclusive        |
| `ectl terminate`                    | Skips the destructive confirmation prompt (use with care in scripts) |
| `ectl init --force`                 | Skips the reinitialize confirmation prompt                           |
| `ectl launch/deploy --allow-any-ip` | Auto-confirms the security warning (warning still printed to stderr) |


---



### `ectl init`

**Purpose:** One-time setup. Creates the `.ectl/` directory tree, validates AWS credentials, generates or imports an SSH key pair, resolves a Ubuntu LTS AMI, writes `config.json`, creates `.ectlignore`, and appends `.ectl/` to `.gitignore`.

**Usage:**

```powershell
ectl init [options]
```

**Interactive wizard:** If you omit flags, ectl prompts for:

- **AWS region** (default: `AWS_REGION`, `AWS_DEFAULT_REGION`, or `us-east-1`)
- **EC2 instance type** (choices: `t3.micro`, `t3.small`, `t3.medium`, `t3.large`, `t3.xlarge`)
- **Ubuntu LTS AMI** (22.04 / 24.04 / 26.04 candidates for the region)

In `--json` mode, prompts are skipped where possible; AMI defaults to Ubuntu 24.04 if available, otherwise the first candidate.


| Option                   | Description                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--region <region>`      | AWS region (e.g. `us-east-1`). Skips the region prompt.                                                                                                                 |
| `--instance-type <type>` | EC2 instance type (e.g. `t3.medium`). Skips the instance type prompt.                                                                                                   |
| `--ami-id <amiId>`       | Specific Ubuntu LTS AMI ID. Skips the AMI selection prompt.                                                                                                             |
| `--import-key <path>`    | Import an existing PEM private key instead of generating a new one. The key is copied to `.ectl/keys/ectl-key.pem` and registered in AWS if needed.                     |
| `--force`                | Reinitialize an existing `.ectl/` directory. **Destructive** — deletes the current `.ectl/` tree after confirmation (confirmation skipped when combined with `--json`). |
| `--json`                 | Machine-readable output envelope                                                                                                                                        |
| `--verbose`              | Debug logging                                                                                                                                                           |


**Examples:**

```powershell
# Interactive setup
ectl init

# Non-interactive setup (CI or scripting)
ectl init --region us-east-1 --instance-type t3.medium --json

# Use your own existing key pair
ectl init --import-key C:\Users\me\.ssh\my-ec2-key.pem

# Start over (after terminating any active task)
ectl init --force
```

**After init:** Add a run command (`.ectl/run.sh` or plan to use `--run`) and run `ectl deploy` or the step-by-step commands.

**Failure cases:**

- `.ectl/` already exists → run `ectl terminate` if a task is active, then `ectl init --force`
- Invalid AWS credentials → fix credentials (see [AWS setup](#aws-setup-and-credentials)) and retry

---



### `ectl launch`

**Purpose:** Provision AWS resources for a task — security group (SSH on port 22), EC2 instance in the default VPC with a public IP, required tags, and local state file. Waits for the instance to pass status checks and verifies SSH connectivity.

**Usage:**

```powershell
ectl launch [options]
```


| Option           | Description                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <task>`  | Task name. Default: `default`.                                                                                                                                                                                               |
| `--allow-any-ip` | Allow SSH from **any IP** (`0.0.0.0/0`) instead of only your current public IPv4. Shows a security warning and requires confirmation (auto-confirmed with `--json`). **Not recommended** unless you understand the exposure. |
| `--json`         | Machine-readable output                                                                                                                                                                                                      |
| `--verbose`      | Debug logging                                                                                                                                                                                                                |


**What it creates:**

- Security group named `ectl-<projectSlug>-<taskName>`
- EC2 instance tagged with `ectl:project`, `ectl:task`, `ectl:created-at`, `ectl:created-by`
- State file at `.ectl/tasks/<name>/state.json`

**Default SSH rule:** Port 22 open only to **your detected public IPv4 /32**. ectl detects your IP automatically; if your IP changes, use `ectl status` to reconcile or relaunch.

**Examples:**

```powershell
ectl launch
ectl launch --name default
ectl launch --allow-any-ip          # Opens SSH worldwide (with warning)
ectl launch --json
```

**Next steps:** `ectl push` then `ectl run`, or use `ectl deploy` to do all three.

**Failure cases:**

- Another active task exists → `ectl terminate` first
- No default VPC or quota limits → check AWS Console

---



### `ectl push`

**Purpose:** Upload your project to the running EC2 instance. Builds a zip archive honoring `.ectlignore`, uploads via SFTP, and extracts into `remoteWorkDir` on the instance (replacing previous content).

**Usage:**

```powershell
ectl push [options]
```


| Option          | Description                                      |
| --------------- | ------------------------------------------------ |
| `--name <task>` | Task name. Default: the current **active task**. |
| `--json`        | Machine-readable output                          |
| `--verbose`     | Debug logging                                    |


**Requires:** An active task in `running` or `stopped` status with a reachable public IP.

**Examples:**

```powershell
ectl push
ectl push --name default
ectl push --verbose
```

**Next step:** `ectl run` to bootstrap Node/pm2 and start your process.

---



### `ectl run`

**Purpose:** Connect to the instance, bootstrap the environment on first use (install `curl`, `unzip`, Node.js matching `config.nodeVersion`, npm, and pm2), then start your command under pm2. Writes `.ectl/tasks/<name>/run.json` and sets task status to `running`.

**Usage:**

```powershell
ectl run [options]
```


| Option            | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `--name <task>`   | Task name. Default: active task.                                                             |
| `--run <command>` | Shell command to execute on the remote instance. **Overrides** `.ectl/run.sh` when provided. |
| `--json`          | Machine-readable output                                                                      |
| `--verbose`       | Debug logging                                                                                |


**Run command priority:**

1. `--run "<command>"` if provided
2. `.ectl/run.sh` if it exists
3. Error if neither is available

**Examples:**

```powershell
ectl run --run "npm install && npm start"
ectl run --run "node scripts/batch-job.js"
ectl run                                    # uses .ectl/run.sh
ectl run --name default --run "npm test"
```

**Next steps:** `ectl logs default --follow` or `ectl status`.

---



### `ectl deploy`

**Purpose:** One-shot workflow — runs **launch → push → run** in sequence. Best for the common "just run my job" path.

**Usage:**

```powershell
ectl deploy [options]
```


| Option            | Description                                     |
| ----------------- | ----------------------------------------------- |
| `--name <task>`   | Task name. Default: `default`.                  |
| `--run <command>` | Shell command to run (same rules as `ectl run`) |
| `--allow-any-ip`  | Same as `ectl launch --allow-any-ip`            |
| `--json`          | Machine-readable output                         |
| `--verbose`       | Debug logging                                   |


**Examples:**

```powershell
ectl deploy --run "npm install && npm run build"
ectl deploy --run "python3 main.py" --name default
ectl deploy --verbose --run "npm start"
ectl deploy --allow-any-ip --run "npm start"   # not recommended
```

**Partial failure behavior:** If deploy fails partway (e.g. push succeeds but run fails), **AWS resources are left running** so you can debug. ectl prints recovery hints: `ectl status`, `ectl ssh`, `ectl terminate`. Task state may be set to `failed`.

**Next steps:** `ectl logs default --follow`, `ectl status`, `ectl pull` when done.

---



### `ectl status`

**Purpose:** Show the current task's state in a human-readable table. Automatically **reconciles** with AWS (`DescribeInstances`, security groups) and queries pm2 over SSH when the instance is reachable. Updates local state if the public IP changed or the instance was terminated externally.

**Usage:**

```powershell
ectl status [options]
```


| Option          | Description                      |
| --------------- | -------------------------------- |
| `--name <task>` | Task name. Default: active task. |
| `--json`        | Machine-readable output          |
| `--verbose`     | Debug logging                    |


**Displayed fields (human mode):**


| Field                          | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| Task                           | Task name                                                          |
| Status                         | Local lifecycle status (color-coded)                               |
| Instance                       | EC2 instance ID                                                    |
| Public IP                      | Current public IPv4                                                |
| Security group                 | Security group ID                                                  |
| Region                         | AWS region                                                         |
| AWS instance                   | Live EC2 state from AWS (`running`, `stopped`, `terminated`, etc.) |
| pm2                            | Process status and PID, or `unreachable` / `n/a`                   |
| Run command / source / started | From `run.json` if the process was started                         |
| Last reconciled                | Timestamp of last AWS sync                                         |


**Examples:**

```powershell
ectl status
ectl status --json | ConvertFrom-Json
ectl status --name default
```

If no active task exists, ectl prints `No active task.` and exits with code 0.

---



### `ectl logs`

**Purpose:** Fetch or stream **pm2 logs** for the task's process on the remote instance.

**Usage:**

```powershell
ectl logs [task] [options]
```


| Argument / option | Description                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `[task]`          | Optional task name. Default: active task. Example: `ectl logs default`                          |
| `--lines <n>`     | Number of log lines to show for a one-shot fetch. Default: **100**. Must be a positive integer. |
| `-f`, `--follow`  | Stream logs in real time until you press **Ctrl+C**. Cannot be combined with `--json`.          |
| `--json`          | Machine-readable output (one-shot fetch only)                                                   |
| `--verbose`       | Debug logging                                                                                   |


**Examples:**

```powershell
ectl logs default
ectl logs default --lines 500
ectl logs --follow
ectl logs default -f
ectl logs default --lines 50 --json
```

In `--follow` mode, ectl connects via SSH and streams stdout/stderr from pm2 until interrupted.

---



### `ectl pull`

**Purpose:** Download artifact files from the remote instance to your local machine. Paths come from `artifactPaths` in `config.json` unless overridden.

**Usage:**

```powershell
ectl pull [options]
```


| Option            | Description                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--name <task>`   | Task name. Default: active task.                                                                                                     |
| `--output <path>` | Override the local destination directory. Default: `.ectl/logs/<task-name>/`                                                         |
| `--paths <paths>` | Comma-separated list of remote paths for this run only. Overrides `artifactPaths` in config. Example: `--paths output/,logs/run.log` |
| `--json`          | Machine-readable output                                                                                                              |
| `--verbose`       | Debug logging                                                                                                                        |


**Requires:** At least one path — either configured in `config.json` → `artifactPaths` or passed via `--paths`. Fails with a clear message if no paths are configured.

**Examples:**

```powershell
# Uses artifactPaths from .ectl/config.json
ectl pull

# One-off paths without editing config
ectl pull --paths "output/results.csv,logs/"

# Custom local folder
ectl pull --output C:\Downloads\my-job-output
ectl pull --paths "output/" --output .\results
```

**Next step:** `ectl terminate` when you no longer need the instance.

---



### `ectl ssh`

**Purpose:** Open an **interactive shell** on the task instance as `config.sshUser` (default `ubuntu`). Uses `.ectl/keys/ectl-key.pem` via `node-ssh` — no Windows OpenSSH configuration required.

**Usage:**

```powershell
ectl ssh [options]
```


| Option          | Description                      |
| --------------- | -------------------------------- |
| `--name <task>` | Task name. Default: active task. |
| `--verbose`     | Debug logging                    |


**Note:** `--json` is **not supported** (interactive session). Exit the shell with **Ctrl+D** or type `exit`.

**Examples:**

```powershell
ectl ssh
ectl ssh --name default
ectl ssh --verbose
```

**Requires:** Active task with reachable public IP.

---



### `ectl stop`

**Purpose:** Stop the **pm2 process** on the instance without destroying the EC2 instance. Useful when you want to pause compute work but keep the machine for faster restart or inspection.

**Usage:**

```powershell
ectl stop [options]
```


| Option          | Description                      |
| --------------- | -------------------------------- |
| `--name <task>` | Task name. Default: active task. |
| `--json`        | Machine-readable output          |
| `--verbose`     | Debug logging                    |


Updates task status to `stopped`. The instance keeps running (you continue paying for EC2).

**Examples:**

```powershell
ectl stop
ectl stop --name default
```

**Next steps:** `ectl run` to restart the process, `ectl status`, or `ectl terminate` when finished.

If the process is already stopped, ectl reports that and suggests next commands.

---



### `ectl terminate`

**Purpose:** Tear down AWS resources for the task — terminate the EC2 instance, wait until terminated, delete the security group, and update local state to `terminated`. **Does not** delete the SSH key pair in `.ectl/keys/` (reused on next launch).

**Usage:**

```powershell
ectl terminate [options]
```


| Option          | Description                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `--name <task>` | Task name. Default: active task.                                                                     |
| `--json`        | Machine-readable output. **Skips the confirmation prompt** — intended for automation; use carefully. |
| `--verbose`     | Debug logging                                                                                        |


**Interactive confirmation:** In normal (non-JSON) mode, ectl asks you to confirm before terminating. This cannot be undone.

**Examples:**

```powershell
ectl terminate
ectl terminate --name default
ectl terminate --json    # no prompt; for scripts only
```

**Next steps:** `ectl launch` or `ectl deploy` to start a new task.

---



## Typical workflows



### Run a Node.js batch job end-to-end

```powershell
cd C:\Projects\my-app
ectl init
ectl deploy --run "npm install && node scripts/process-data.js"
ectl logs default --follow
ectl pull --paths "output/"
ectl terminate
```



### Iterate on code without relaunching the instance

```powershell
ectl push
ectl run --run "npm install && npm test"
ectl logs default --follow
```



### Debug a failed deploy

```powershell
ectl status                    # See AWS vs local state
ectl ssh                       # Inspect files, run commands manually
ectl logs default --lines 200
ectl terminate                 # Clean up when done
```



### Stop work overnight, resume next day

```powershell
ectl stop
# ... next day ...
ectl run --run "npm start"
ectl logs default --follow
```



### Scripting with JSON

```powershell
$result = ectl status --json | ConvertFrom-Json
if ($result.ok -and $result.data.status -eq "running") {
  ectl logs default --lines 20 --json
}
```

---



## JSON output (scripting)

All commands except interactive `ssh` and `logs --follow` support `--json`. Output is a consistent envelope on stdout:

**Success:**

```json
{
  "ok": true,
  "command": "status",
  "data": { },
  "error": null
}
```

**Failure:**

```json
{
  "ok": false,
  "command": "deploy",
  "data": null,
  "error": {
    "code": "ACTIVE_TASK_EXISTS",
    "message": "Task 'default' is still running. Run ectl terminate first."
  }
}
```

Exit codes: **0** on success, **non-zero** on failure.

Decorative spinners and tables are suppressed in JSON mode. Use `--verbose` for debug details on stderr.

---



## Security notes


| Topic                  | Guidance                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Private keys**       | Never commit `.ectl/`. Init appends `.ectl/` to `.gitignore`. Do not share `.ectl/keys/`.                     |
| **SSH access**         | By default, only **your current public IP** can SSH to the instance. Avoid `--allow-any-ip` unless necessary. |
| **Secrets in uploads** | `.env` is **not** in the default `.ectlignore`. Add `.env` manually if your project contains secrets.         |
| **AWS credentials**    | Stored only in the standard AWS chain — never in `.ectl/config.json`.                                         |
| **Terminate**          | Always confirm termination in interactive mode. Use `--json` terminate only in trusted automation.            |


Required AWS tags on instances and security groups: `ectl:project`, `ectl:task`, `ectl:created-at`, `ectl:created-by`.

---



## Common errors and recovery


| Error code                | Meaning                                  | What to do                                                                 |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `NOT_INITIALIZED`         | No `.ectl/` in project                   | Run `ectl init`                                                            |
| `ACTIVE_TASK_EXISTS`      | A task is already running or provisioned | `ectl status`, then `ectl terminate` if done                               |
| `NO_ACTIVE_TASK`          | No task to operate on                    | `ectl launch` or `ectl deploy`                                             |
| `AWS_CREDENTIALS_INVALID` | Bad or missing AWS credentials           | Fix [AWS setup](#aws-setup-and-credentials)                                |
| `RUN_COMMAND_MISSING`     | No `--run` and no `.ectl/run.sh`         | Add one before `run` or `deploy`                                           |
| `ARTIFACT_PATHS_EMPTY`    | Nothing to pull                          | Set `artifactPaths` in config or use `--paths`                             |
| `SSH_CONNECTION_FAILED`   | Cannot reach instance                    | Check security group IP, instance state, `ectl status`                     |
| `DEPLOY_PARTIAL_FAILURE`  | Deploy stopped mid-flow                  | Resources left running — `ectl ssh`, fix, retry `run`, or `ectl terminate` |
| `INSTANCE_NO_PUBLIC_IP`   | Instance has no public IPv4              | Check default VPC / subnet settings                                        |


Every error message includes a suggested next command where possible.

---



## Development scripts

For contributors working on the ectl source code:


| Script              | Description                             |
| ------------------- | --------------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`           |
| `npm run dev`       | Run CLI via `tsx` without building      |
| `npm run start`     | Run compiled CLI (`node dist/index.js`) |
| `npm run typecheck` | Typecheck without emit                  |
| `npm test`          | Run vitest unit tests                   |


---



## Further documentation

- [Software Requirements Specification (SRS)](docs/SRS.md) — full requirements, schemas, and architecture
- [Manual test checklist (Windows)](docs/MANUAL-TEST.md)
- [Contributing](CONTRIBUTING.md)

---



## License

[MIT](LICENSE) — free to use, modify, and distribute.