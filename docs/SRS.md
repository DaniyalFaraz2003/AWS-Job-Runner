# Software Requirements Specification (SRS)

## ectl — EC2 Task Launcher CLI

| Field | Value |
|-------|-------|
| **Document version** | 1.0 |
| **Date** | 2026-07-03 |
| **Status** | Approved for development (decisions locked) |
| **Product name** | `ectl` |
| **Repository** | AWS-Job-Runner |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Overall Description](#2-overall-description)
3. [System Architecture](#3-system-architecture)
4. [Project-Local Configuration Model](#4-project-local-configuration-model)
5. [Functional Requirements](#5-functional-requirements)
6. [Command Reference](#6-command-reference)
7. [External Interfaces](#7-external-interfaces)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Security Requirements](#9-security-requirements)
10. [Error Handling & Recovery](#10-error-handling--recovery)
11. [Testing Requirements](#11-testing-requirements)
12. [Distribution & Release](#12-distribution--release)
13. [Scope Boundaries](#13-scope-boundaries)
14. [Future Enhancements (Out of v1 Scope)](#14-future-enhancements-out-of-v1-scope)
15. [Appendix A — Decision Log](#appendix-a--decision-log)
16. [Appendix B — Example Workflows](#appendix-b--example-workflows)

---

## 1. Introduction

### 1.1 Purpose

This document specifies the software requirements for **ectl**, a command-line tool that automates running long-lived compute tasks on Amazon EC2. The tool replaces a manual workflow (launch instance → upload project → install dependencies → run process → pull artifacts → terminate) with a git-style, project-local CLI experience.

### 1.2 Intended Audience

- Developers who run batch or long-running Node.js (or shell-based) jobs on EC2
- Open-source contributors and maintainers who package and distribute `ectl` via npm
- Anyone self-hosting or extending the CLI for their AWS workflows

### 1.3 Problem Statement

Developers need to offload long-running tasks to cloud compute without:

- Manually managing EC2 lifecycle steps in the AWS Console
- Wrestling with Windows-specific SSH key permission issues
- Maintaining ad-hoc shell scripts that differ per project
- Storing EC2 state in scattered notes or global machine config

### 1.4 Product Vision

`ectl` works like **git for cloud tasks**: run `ectl init` in a project directory, and all configuration, credentials, instance state, and pulled logs live in a `.ectl/` folder beside the code — never in a global config directory.

---

## 2. Overall Description

### 2.1 Product Perspective

`ectl` is a standalone CLI application that orchestrates:

| Layer | Technology |
|-------|------------|
| CLI framework | Commander.js |
| Language | TypeScript |
| Local runtime | Node.js 22+ |
| AWS integration | `@aws-sdk/client-ec2` (SDK v3) |
| Remote access | `node-ssh` (SSH/SFTP, no dependency on system OpenSSH on Windows) |
| Archive transfer | `archiver` + `.ectlignore` parsing |
| Config validation | `zod` |
| UX | `chalk`, `ora`, `cli-table3`, `@inquirer/prompts` |

The tool does **not** require the AWS CLI to be installed. AWS credentials are resolved via the standard AWS SDK credential provider chain.

### 2.2 User Classes

| User | Description |
|------|-------------|
| **Task operator** | Runs `ectl deploy`, monitors with `ectl logs`, retrieves output with `ectl pull`, cleans up with `ectl terminate` |
| **Project maintainer** | Configures `.ectl/config.json`, `.ectlignore`, optional `.ectl/run.sh`, and artifact pull paths |
| **Tool maintainer** | Publishes `ectl` to npm, manages versioning, triages issues and PRs |

### 2.3 Operating Environment

| Environment | v1 Support |
|-------------|------------|
| **Windows (PowerShell)** | **Primary — full support required** |
| macOS | Not required in v1 |
| Linux | Not required in v1 |
| WSL | Not required in v1 |

### 2.4 Constraints

- **One active task per project directory** — only one EC2 task may be running (or provisioned) at a time per initialized project
- **One instance per task** — each task maps 1:1 to a dedicated EC2 instance
- **Default VPC only in v1** — instances launch in the account default VPC with auto-assigned public IP
- **Open-source distribution** — published on npm under the MIT license; source on GitHub
- **Minimal automated testing in v1** — manual verification acceptable; unit tests with mocks are encouraged but not gate release

### 2.5 Assumptions

- Users have AWS credentials with sufficient EC2 permissions (broad/admin access assumed for v1)
- Target AWS accounts have a **default VPC** with internet gateway and auto-assign public IP enabled
- Users run Node.js **22+** locally (remote Node version matches local)
- Long-running processes are managed with **pm2** on the remote instance
- Default remote OS is **Ubuntu 22.04 LTS** (`ubuntu` SSH user)

---

## 3. System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User (PowerShell)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ ectl commands
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      CLI Layer (Commander)                   │
│  init │ deploy │ launch │ push │ run │ status │ logs │ ...  │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│ ConfigManager│  │  StateStore  │  │ TaskOrchestrator │
│ + .ectlignore│  │ .ectl/tasks/ │  │  (deploy flow)   │
└──────────────┘  └──────────────┘  └────────┬─────────┘
        │                  │                   │
        ▼                  ▼          ┌─────────┴─────────┐
┌──────────────┐  ┌──────────────┐   ▼         ▼         ▼
│   .ectl/     │  │  JSON state  │ AwsProv. SshMgr  TransferMgr
│  on disk     │  │  per task    │     │       │          │
└──────────────┘  └──────────────┘     ▼       ▼          ▼
                                    AWS EC2   SSH      Zip/SFTP
                                    API       Session  Upload
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │  EC2 Instance   │
                                    │  Ubuntu 22.04   │
                                    │  Node + pm2     │
                                    └─────────────────┘
```

### 3.2 Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| **ConfigManager** | Discover project root (directory containing `.ectl/`), read/write `config.json`, parse `.ectlignore`, validate with zod |
| **StateStore** | CRUD for `.ectl/tasks/<name>/state.json` and `run.json`; enforce single active task constraint |
| **AwsProvisioner** | Key pair create/import, security group lifecycle, AMI resolution, `RunInstances`, tagging, terminate, describe/reconcile |
| **SshManager** | Connect with exponential backoff, remote exec, interactive shell for `ectl ssh` |
| **TransferManager** | Build zip archive honoring `.ectlignore`, upload, remote unzip; download configured artifact paths |
| **ProcessManager** | Remote bootstrap (Node/npm/unzip/pm2 install on first connect), pm2 start/stop/logs |
| **TaskOrchestrator** | Compose modules for multi-step flows (`deploy`); implement failure-leave-resources policy |

### 3.3 Sequence — `ectl deploy` (Happy Path)

```
User          ectl           AWS SDK        SSH/EC2
 │              │               │              │
 │─ deploy ────►│               │              │
 │              │─ create SG ──►│              │
 │              │─ run inst ───►│              │
 │              │─ wait OK ────►│              │
 │              │─ SSH retry ─────────────────►│
 │              │─ bootstrap ─────────────────►│ (install node, pm2)
 │              │─ zip+upload ────────────────►│
 │              │─ npm install ───────────────►│
 │              │─ pm2 start ─────────────────►│
 │              │─ write state │              │
 │◄─ success ───│               │              │
```

---

## 4. Project-Local Configuration Model

### 4.1 Directory Layout

After `ectl init`, a project directory SHALL contain:

```
my-project/
├── .ectl/
│   ├── config.json                 # Project defaults (region, instance type, AMI, paths)
│   ├── keys/
│   │   └── ectl-key.pem            # Project-scoped private key (generated or imported)
│   ├── tasks/
│   │   └── <task-name>/
│   │       ├── state.json          # AWS resource IDs, IPs, lifecycle status
│   │       └── run.json            # Command/script used, pm2 process name, timestamps
│   ├── logs/                       # Default destination for ectl pull output
│   │   └── <task-name>/
│   └── run.sh                      # Optional: default run script (see FR-RUN-1)
├── .ectlignore                     # Paths excluded from upload archive
└── .gitignore                      # MUST include .ectl/ (auto-appended by ectl init)
```

### 4.2 `config.json` Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | number | Yes | `1` | Config schema version |
| `region` | string | Yes | From AWS default chain | AWS region for all resources |
| `instanceType` | string | Yes | `t3.medium` | EC2 instance type |
| `amiId` | string | No | Latest Ubuntu 22.04 LTS x86_64 | Override AMI; auto-resolved if omitted |
| `sshUser` | string | Yes | `ubuntu` | SSH login user |
| `remoteWorkDir` | string | Yes | `/home/ubuntu/ectl-workspace` | Remote directory for project files |
| `keyPairName` | string | Yes | `ectl-<project-slug>-key` | AWS EC2 key pair name |
| `keySource` | `"generated"` \| `"imported"` | Yes | `"generated"` | How the key was created |
| `nodeVersion` | string | No | Local Node major version at init | Node version to install remotely |
| `artifactPaths` | string[] | No | `[]` | Remote paths downloaded by `ectl pull` (relative to `remoteWorkDir` or absolute) |
| `projectSlug` | string | Yes | Derived from directory name | Used in resource naming and tags |
| `tags` | Record<string, string> | No | `{}` | Additional AWS tags merged with required tags |

### 4.3 `state.json` Schema (per task)

| Field | Type | Description |
|-------|------|-------------|
| `taskName` | string | Task identifier |
| `status` | enum | `provisioning` \| `running` \| `stopped` \| `completed` \| `failed` \| `terminated` |
| `instanceId` | string | EC2 instance ID |
| `publicIp` | string | Public IPv4 (empty if not yet assigned) |
| `securityGroupId` | string | Associated security group |
| `keyPairName` | string | AWS key pair name |
| `region` | string | Region where resources exist |
| `createdAt` | ISO8601 | Task creation timestamp |
| `updatedAt` | ISO8601 | Last state mutation |
| `lastReconciledAt` | ISO8601 | Last AWS sync via `ectl status` |

### 4.4 `run.json` Schema (per task)

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Actual shell command executed (from `--run` or derived from `run.sh`) |
| `source` | `"flag"` \| `"run.sh"` | How the run command was specified |
| `pm2ProcessName` | string | pm2 process name (defaults to task name) |
| `startedAt` | ISO8601 | When pm2 process was started |
| `remoteWorkDir` | string | Snapshot of remote work directory at run time |

### 4.5 `.ectlignore` Format

- Gitignore-compatible syntax (one pattern per line)
- Comments with `#`
- Applied when building the upload zip archive

**Default patterns created by `ectl init`:**

```
node_modules/
.git/
.ectl/
dist/
build/
.next/
coverage/
```

Users MAY append project-specific patterns (e.g. `.env`, `*.log`, `tmp/`).

### 4.6 Single Active Task Constraint

Because v1 supports **one task at a time per project**:

- If an active task exists (`status` ∈ `provisioning`, `running`, `stopped`, `failed`), commands that create or launch resources (`deploy`, `launch`) SHALL fail with a clear error unless the existing task is terminated first
- Default task name SHALL be `default` when `--name` is omitted
- Task folder still lives at `.ectl/tasks/<name>/` for consistency and future multi-task support

### 4.7 `.ectl/run.sh` (Optional)

- If present, used as the default run script when `--run` is not provided
- Executed on the remote instance from `remoteWorkDir` via bash
- Must be executable semantics: `bash .ectl/run.sh` (or `./.ectl/run.sh` after chmod on remote)
- If neither `.ectl/run.sh` nor `--run` is provided, `ectl deploy` and `ectl run` SHALL fail with a descriptive error

---

## 5. Functional Requirements

Requirements use IDs traceable to commands and modules.

### 5.1 Initialization — `ectl init`

| ID | Requirement |
|----|-------------|
| **FR-INIT-1** | `ectl init` SHALL create `.ectl/` directory structure as defined in §4.1 |
| **FR-INIT-2** | `ectl init` SHALL fail if `.ectl/` already exists unless `--force` is passed |
| **FR-INIT-3** | `ectl init` SHALL validate AWS credentials by calling EC2 `DescribeRegions` (or equivalent lightweight call) |
| **FR-INIT-4** | `ectl init` SHALL run an interactive wizard (`@inquirer/prompts`) for region and instance type if not passed via flags |
| **FR-INIT-5** | `ectl init` SHALL generate a new EC2 key pair by default, store private key at `.ectl/keys/ectl-key.pem`, and record `keySource: "generated"` |
| **FR-INIT-6** | `ectl init --import-key <path>` SHALL copy an existing `.pem` to `.ectl/keys/ectl-key.pem` and register/import the key pair name in AWS if not already present |
| **FR-INIT-7** | `ectl init` SHALL create `.ectlignore` with default patterns (§4.5) if missing |
| **FR-INIT-8** | `ectl init` SHALL append `.ectl/` to `.gitignore` if `.gitignore` exists and does not already contain it |
| **FR-INIT-9** | `ectl init` SHALL record local Node.js version in `config.json` as `nodeVersion` for remote matching |
| **FR-INIT-10** | `ectl init` SHALL resolve default Ubuntu 22.04 LTS AMI ID for the configured region if `amiId` not specified |

### 5.2 AWS Provisioning — `ectl launch`

| ID | Requirement |
|----|-------------|
| **FR-LAUNCH-1** | `ectl launch` SHALL create a dedicated security group named `ectl-<projectSlug>-<taskName>` |
| **FR-LAUNCH-2** | Security group ingress SHALL allow TCP port 22 from the caller's detected public IPv4 `/32` by default |
| **FR-LAUNCH-3** | `ectl launch --allow-any-ip` SHALL allow SSH from `0.0.0.0/0` and emit a security warning |
| **FR-LAUNCH-4** | `ectl launch` SHALL call `RunInstances` in the default VPC with `AssociatePublicIpAddress: true` |
| **FR-LAUNCH-5** | `ectl launch` SHALL wait for `waitUntilInstanceStatusOk` before reporting success |
| **FR-LAUNCH-6** | `ectl launch` SHALL apply required tags (§9.3) to instance and security group |
| **FR-LAUNCH-7** | `ectl launch` SHALL write/update `.ectl/tasks/<name>/state.json` with `status: provisioning` then `running` |
| **FR-LAUNCH-8** | `ectl launch` SHALL enforce single active task constraint (§4.6) |
| **FR-LAUNCH-9** | `ectl launch` SHALL retry SSH connection (exponential backoff, max 60s) after instance status OK before completing |

### 5.3 File Transfer — `ectl push`

| ID | Requirement |
|----|-------------|
| **FR-PUSH-1** | `ectl push` SHALL build a zip archive of the project root honoring `.ectlignore` |
| **FR-PUSH-2** | `ectl push` SHALL upload the archive to the active task's EC2 instance via SFTP |
| **FR-PUSH-3** | `ectl push` SHALL remotely unzip into `remoteWorkDir`, replacing existing content |
| **FR-PUSH-4** | `ectl push` SHALL require an active task in `running` or `stopped` state with valid `publicIp` |
| **FR-PUSH-5** | `ectl push` SHALL display upload progress (spinner or byte progress via `ora`) |

### 5.4 Remote Execution — `ectl run`

| ID | Requirement |
|----|-------------|
| **FR-RUN-1** | `ectl run` SHALL resolve command from `--run "<cmd>"` OR `.ectl/run.sh` (script takes precedence if both provided: **flag overrides script** — document: user chose "both"; typically run.sh if no flag; flag if provided) |
| **FR-RUN-2** | On first SSH connect for a task, `ectl run` / bootstrap SHALL install: `curl`, `unzip`, Node.js (version matching `config.nodeVersion`), npm, and pm2 globally |
| **FR-RUN-3** | `ectl run` SHALL start the command under pm2 with process name equal to task name |
| **FR-RUN-4** | `ectl run` SHALL write `.ectl/tasks/<name>/run.json` |
| **FR-RUN-5** | `ectl run` SHALL update task `status` to `running` |
| **FR-RUN-6** | `ectl run` SHALL NOT terminate SSH session requirement for pm2 — process MUST survive disconnect |

**Run command resolution priority (locked decision):**

1. If `--run` flag provided → use flag value (`source: "flag"`)
2. Else if `.ectl/run.sh` exists → execute script (`source: "run.sh"`)
3. Else → error

### 5.5 Composite Deploy — `ectl deploy`

| ID | Requirement |
|----|-------------|
| **FR-DEPLOY-1** | `ectl deploy` SHALL execute sequentially: `launch` → `push` → `run` (internal orchestration) |
| **FR-DEPLOY-2** | `ectl deploy` SHALL accept `--name`, `--run`, and `--allow-any-ip` flags |
| **FR-DEPLOY-3** | On partial failure, `ectl deploy` SHALL leave all created AWS resources intact |
| **FR-DEPLOY-4** | On partial failure, `ectl deploy` SHALL print recovery commands: `ectl status`, `ectl ssh`, `ectl terminate` |
| **FR-DEPLOY-5** | `ectl deploy` SHALL update state to `failed` with error message recorded in state if orchestration fails |
| **FR-DEPLOY-6** | `ectl deploy` SHALL enforce single active task constraint |

### 5.6 Status & Reconciliation — `ectl status`

| ID | Requirement |
|----|-------------|
| **FR-STATUS-1** | `ectl status` SHALL display the active task's local state in a human-readable table |
| **FR-STATUS-2** | `ectl status` SHALL automatically reconcile local state with AWS (`DescribeInstances`, `DescribeSecurityGroups`) |
| **FR-STATUS-3** | If instance no longer exists in AWS, state SHALL update to `terminated` and user SHALL be warned |
| **FR-STATUS-4** | `ectl status` SHALL query remote pm2 status via SSH when instance is reachable |
| **FR-STATUS-5** | `ectl status` with no active task SHALL report "no active task" exit code 0 |
| **FR-STATUS-6** | `ectl status --json` SHALL output structured JSON (see §7.3) |

### 5.7 Logs — `ectl logs`

| ID | Requirement |
|----|-------------|
| **FR-LOGS-1** | `ectl logs <task>` SHALL fetch pm2 logs for the task's process |
| **FR-LOGS-2** | `ectl logs --follow` SHALL stream logs in real time until interrupted |
| **FR-LOGS-3** | `ectl logs --lines <n>` SHALL limit initial output (default: 100) |

### 5.8 Artifact Retrieval — `ectl pull`

| ID | Requirement |
|----|-------------|
| **FR-PULL-1** | `ectl pull` SHALL download paths listed in `config.json` → `artifactPaths` |
| **FR-PULL-2** | `ectl pull` SHALL save files under `.ectl/logs/<task-name>/` preserving relative structure |
| **FR-PULL-3** | `ectl pull --output <path>` SHALL override default local destination |
| **FR-PULL-4** | `ectl pull` SHALL fail with clear message if `artifactPaths` is empty |
| **FR-PULL-5** | `ectl pull` MAY accept `--paths` to override config paths for a single invocation |

### 5.9 Interactive Access — `ectl ssh`

| ID | Requirement |
|----|-------------|
| **FR-SSH-1** | `ectl ssh` SHALL open an interactive shell on the task instance as `config.sshUser` |
| **FR-SSH-2** | `ectl ssh` SHALL use `.ectl/keys/ectl-key.pem` for authentication via `node-ssh` |
| **FR-SSH-3** | `ectl ssh` SHALL require active task with reachable public IP |

### 5.10 Process Control — `ectl stop`

| ID | Requirement |
|----|-------------|
| **FR-STOP-1** | `ectl stop` SHALL run `pm2 stop <processName>` on the remote instance |
| **FR-STOP-2** | `ectl stop` SHALL update task status to `stopped` |
| **FR-STOP-3** | `ectl stop` SHALL NOT terminate the EC2 instance |

### 5.11 Teardown — `ectl terminate`

| ID | Requirement |
|----|-------------|
| **FR-TERM-1** | `ectl terminate` SHALL call `TerminateInstances` for the task's instance |
| **FR-TERM-2** | `ectl terminate` SHALL wait for `waitUntilInstanceTerminated` |
| **FR-TERM-3** | `ectl terminate` SHALL delete the task's security group |
| **FR-TERM-4** | `ectl terminate` SHALL update task status to `terminated` |
| **FR-TERM-5** | `ectl terminate` SHALL NOT delete the key pair or `.ectl/keys/` (reusable for next launch) |
| **FR-TERM-6** | `ectl terminate` MAY optionally delete AWS key pair with `--delete-key` (future flag; not required v1) |

### 5.12 Global CLI Behavior

| ID | Requirement |
|----|-------------|
| **FR-CLI-1** | All commands SHALL support global `--json` flag for machine-readable output |
| **FR-CLI-2** | All commands SHALL resolve project root by walking up from CWD to find `.ectl/` |
| **FR-CLI-3** | All commands SHALL exit with code `0` on success, non-zero on failure |
| **FR-CLI-4** | `--help` SHALL be auto-generated by Commander for all commands |
| **FR-CLI-5** | Verbose logging SHALL be available via `--verbose` global flag |

---

## 6. Command Reference

### 6.1 Command Summary

| Command | Description |
|---------|-------------|
| `ectl init [options]` | Initialize `.ectl/` in current directory |
| `ectl launch [--name <task>] [--allow-any-ip]` | Provision EC2 instance + security group |
| `ectl push [--name <task>]` | Upload project zip to instance |
| `ectl run [--name <task>] [--run "<cmd>"]` | Bootstrap remote env and start pm2 process |
| `ectl deploy [--name <task>] [--run "<cmd>"] [--allow-any-ip]` | launch + push + run |
| `ectl status [--name <task>]` | Show task state (auto-reconcile with AWS) |
| `ectl logs <task> [--follow] [--lines <n>]` | View pm2 logs |
| `ectl pull [--name <task>] [--output <path>] [--paths <p1,p2>]` | Download configured artifacts |
| `ectl ssh [--name <task>]` | Interactive SSH session |
| `ectl stop [--name <task>]` | Stop pm2 process, keep instance |
| `ectl terminate [--name <task>]` | Terminate instance and delete security group |

### 6.2 Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON to stdout; suppress decorative logs |
| `--verbose` | Enable debug logging |
| `--help` | Show command help |

### 6.3 `ectl init` Flags

| Flag | Description |
|------|-------------|
| `--region <region>` | AWS region (skips wizard prompt) |
| `--instance-type <type>` | EC2 instance type |
| `--import-key <path>` | Import existing PEM instead of generating |
| `--force` | Reinitialize existing `.ectl/` (dangerous; requires confirmation) |

---

## 7. External Interfaces

### 7.1 AWS EC2 API (SDK v3)

Operations used:

| Operation | Purpose |
|-----------|---------|
| `CreateKeyPair` | Generate project key |
| `ImportKeyPair` | Import user-provided public key material |
| `CreateSecurityGroup` | Task security group |
| `AuthorizeSecurityGroupIngress` | SSH access rule |
| `DeleteSecurityGroup` | Cleanup on terminate |
| `DescribeImages` | Resolve Ubuntu 22.04 AMI |
| `RunInstances` | Launch task instance |
| `TerminateInstances` | Teardown |
| `DescribeInstances` | Reconciliation, public IP lookup |
| `CreateTags` | Required resource tags |
| `DescribeRegions` | Credential validation |

Waiters:

- `waitUntilInstanceStatusOk`
- `waitUntilInstanceTerminated`

### 7.2 SSH / SFTP Interface (node-ssh)

| Operation | Purpose |
|-----------|---------|
| `connect` | Authenticate with `.ectl/keys/ectl-key.pem` |
| `execCommand` | Remote shell commands (bootstrap, pm2, unzip) |
| `putFile` | Upload zip archive |
| `get` / `getFile` | Download artifact paths |
| `withShell` | Interactive `ectl ssh` |

### 7.3 JSON Output Schema ( `--json` )

All commands SHALL emit a consistent envelope:

```json
{
  "ok": true,
  "command": "status",
  "data": { },
  "error": null
}
```

On failure:

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

### 7.4 Credential Interface

Uses AWS SDK default credential provider chain:

1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`)
2. Shared credentials file (`~/.aws/credentials`)
3. SSO / assumed role profiles via `AWS_PROFILE`

No custom credential storage in `.ectl/`.

---

## 8. Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| **NFR-1** | Performance | `ectl init` completes in < 30 seconds (excluding user wizard input) |
| **NFR-2** | Performance | `ectl push` of a typical project (< 50 MB zipped) completes in < 5 minutes on standard broadband |
| **NFR-3** | Reliability | SSH operations retry with exponential backoff (initial 2s, max 30s interval, 10 attempts) |
| **NFR-4** | Usability | All error messages include suggested next command |
| **NFR-5** | Usability | Progress spinners for operations > 3 seconds |
| **NFR-6** | Maintainability | TypeScript strict mode enabled |
| **NFR-7** | Maintainability | Module boundaries as defined in §3.2 |
| **NFR-8** | Portability | v1 targets **Windows PowerShell** exclusively |
| **NFR-9** | Compatibility | Local Node.js **22+** required (`engines` field in package.json) |
| **NFR-10** | Observability | `--verbose` logs include AWS request IDs where available |

---

## 9. Security Requirements

| ID | Requirement |
|----|-------------|
| **SEC-1** | Private keys MUST NOT be committed — `ectl init` enforces `.ectl/` in `.gitignore` |
| **SEC-2** | SSH ingress defaults to caller IP `/32` only |
| **SEC-3** | `--allow-any-ip` MUST print explicit security warning before proceeding |
| **SEC-4** | `.ectl/` directory SHOULD be created with restrictive permissions where OS supports it |
| **SEC-5** | `node-ssh` reads PEM in-process — no dependency on Windows `icacls` for SSH, but documentation SHOULD mention not sharing `.ectl/keys/` |
| **SEC-6** | Secrets in `.env` are NOT uploaded by default (users must add `.env` to `.ectlignore` explicitly if they need it — default does NOT exclude `.env`; **recommendation documented**) |
| **SEC-7** | No AWS secret keys stored in `.ectl/config.json` |

### 9.1 Required AWS Resource Tags

Applied to EC2 instance and security group:

| Tag Key | Tag Value |
|---------|-----------|
| `ectl:project` | `<projectSlug>` |
| `ectl:task` | `<taskName>` |
| `ectl:created-at` | ISO8601 timestamp |
| `ectl:created-by` | OS username or `$USER` / `$env:USERNAME` |

### 9.2 Security Note on `.env`

Default `.ectlignore` does **not** exclude `.env`. Project maintainers MUST add `.env` to `.ectlignore` manually to prevent uploading secrets. Future version may prompt during `ectl init`.

---

## 10. Error Handling & Recovery

### 10.1 Error Codes

| Code | Condition | User Action |
|------|-----------|-------------|
| `NOT_INITIALIZED` | No `.ectl/` in project tree | Run `ectl init` |
| `ACTIVE_TASK_EXISTS` | Second launch/deploy while task active | Run `ectl terminate` or `ectl status` |
| `NO_ACTIVE_TASK` | Command requires task but none exists | Run `ectl deploy` |
| `AWS_CREDENTIALS_INVALID` | AWS auth failure | Configure AWS credentials |
| `INSTANCE_NO_PUBLIC_IP` | No public IP assigned | Check default VPC / subnet settings |
| `SSH_CONNECTION_FAILED` | Cannot connect after retries | Check security group / IP drift |
| `RUN_COMMAND_MISSING` | No `--run` and no `.ectl/run.sh` | Provide run command |
| `ARTIFACT_PATHS_EMPTY` | `ectl pull` with no paths configured | Set `artifactPaths` in config |
| `DEPLOY_PARTIAL_FAILURE` | deploy stopped mid-orchestration | Debug via `ectl ssh`; terminate when done |

### 10.2 Deploy Failure Policy (Locked)

On **any** failure during `ectl deploy`:

- Created EC2 instance (if any) **remains running**
- Security group **remains**
- Local state reflects `failed` with error detail
- CLI prints instance ID, public IP, and suggested commands

---

## 11. Testing Requirements

Per locked decision: **minimal testing bar for v1**.

| ID | Requirement | Priority |
|----|-------------|----------|
| **TEST-1** | Manual test checklist documented in `docs/MANUAL-TEST.md` | Required |
| **TEST-2** | Unit tests for `ConfigManager`, `.ectlignore` parsing, state transitions | Recommended |
| **TEST-3** | Mocked AWS tests with `aws-sdk-client-mock` | Recommended |
| **TEST-4** | CI pipeline (lint + typecheck) | Required |
| **TEST-5** | Real AWS integration tests in CI | Not required v1 |

---

## 12. Distribution & Release

| Item | Specification |
|------|---------------|
| **Package name** | `ectl` on [npm](https://www.npmjs.com/) |
| **Binary** | `ectl` via `package.json` → `bin` field |
| **Registry** | Public npm registry |
| **License** | MIT |
| **Node engines** | `>=22` |
| **Build** | TypeScript → `dist/`; publish `files: ["dist", "README.md", "LICENSE"]` |
| **Versioning** | SemVer |
| **Source** | [GitHub — AWS-Job-Runner](https://github.com/DaniyalFaraz2003/AWS-Job-Runner) |

### 12.1 Installation

```powershell
npm install -g ectl
```

Or per-project:

```powershell
npm install --save-dev ectl
npx ectl init
```

From source:

```powershell
git clone https://github.com/DaniyalFaraz2003/AWS-Job-Runner.git
cd AWS-Job-Runner
npm install && npm run build
```

---

## 13. Scope Boundaries

### 13.1 In Scope (v1)

- Full command set listed in §6.1
- Project-local `.ectl/` configuration
- Ubuntu 22.04 on default VPC
- Zip-based upload with `.ectlignore`
- pm2 process management
- Auto-reconciliation on `ectl status`
- Global `--json` output
- Windows PowerShell support

### 13.2 Out of Scope (v1)

| Feature | Reason |
|---------|--------|
| macOS / Linux CLI support | Deferred |
| Multiple concurrent tasks per project | Deferred (state model预留) |
| Custom VPC / subnet configuration | Deferred |
| User-data bootstrap at launch | SSH bootstrap chosen instead |
| Auto-cleanup on deploy failure | Leave resources policy |
| Cost guardrails / max runtime auto-terminate | Explicitly excluded |
| AWS CLI wrapper / passthrough | SDK-only approach |
| Docker / ECS / Lambda execution | EC2 only |
| IAM least-privilege policy document | Admin access assumed v1 |
| Standalone `.exe` distribution | npm-only v1 |
| Git clone on remote instead of upload | Zip upload chosen |

---

## 14. Future Enhancements (Out of v1 Scope)

1. Multiple named concurrent tasks per project
2. macOS and Linux first-class support
3. Custom VPC, subnet, and elastic IP configuration
4. EC2 user-data bootstrap for faster cold start
5. Optional auto-terminate after configurable max runtime
6. `ectl status --dry-run` and `ectl deploy --dry-run`
7. IAM policy template for least-privilege deployments
8. Standalone binary via `pkg` / Node SEA
9. Open-source contribution guidelines (`CONTRIBUTING.md`)
10. Auto-prompt to add `.env` to `.ectlignore` during init
11. Shared instances across tasks
12. Custom AMI with pre-installed Node/pm2

---

## Appendix A — Decision Log

Decisions captured from stakeholder questionnaire (2026-07-03):

| Topic | Decision |
|-------|----------|
| CLI name | `ectl` |
| Distribution | Public npm + GitHub (MIT) |
| License / audience | Open source worldwide |
| v1 platform | Windows (PowerShell) only |
| CLI framework | Commander.js |
| Tasks per project | Single active task at a time |
| Instance mapping | 1 task = 1 instance |
| State storage | `.ectl/tasks/<name>/state.json` |
| JSON output | Global `--json` on all commands |
| Default AMI | Ubuntu 22.04 LTS (`ubuntu` user) |
| Networking | Default VPC + auto public IP |
| SSH ingress | Caller IP default; `--allow-any-ip` for 0.0.0.0/0 |
| Key management | Generate by default; optional import |
| IAM | Broad/admin access assumed; no policy doc required v1 |
| Resource tags | Required: `ectl:project`, `ectl:task`, `ectl:created-at`, `ectl:created-by` |
| Remote bootstrap | Install Node/npm/pm2 on first SSH connect |
| Process manager | pm2 |
| Run command | `.ectl/run.sh` if no `--run`; `--run` overrides |
| File transfer | Zip with `.ectlignore` |
| Default `.ectlignore` | `node_modules/`, `.git/`, `.ectl/`, `dist/`, `build/`, `.next/`, `coverage/` |
| Pull artifacts | Paths from `config.json` → `artifactPaths` |
| Deploy failure | Leave resources for debugging |
| v1 commands | All: init, deploy, launch, push, run, status, logs, pull, ssh, stop, terminate |
| Reconciliation | Automatic on `ectl status` |
| Cost guardrails | None in v1 |
| Testing | Minimal (manual + lint/typecheck) |
| Local Node | 22+ |
| Remote Node | Match local Node version at init |

---

## Appendix B — Example Workflows

### B.1 First-Time Project Setup

```powershell
cd C:\Projects\my-batch-job
npm install -g ectl

ectl init
# Wizard: region us-east-1, instance type t3.medium

# Edit .ectl/config.json — add artifact paths:
# "artifactPaths": ["output/", "logs/"]

# Optional: create .ectl/run.sh
# npm install && npm start
```

### B.2 Happy Path — One Command Deploy

```powershell
ectl deploy --run "npm install && npm run build"
ectl status
ectl logs default --follow
# ... wait for completion ...
ectl pull
ectl terminate
```

### B.3 Step-by-Step (Debug-Friendly)

```powershell
ectl launch
ectl push
ectl run --run "npm install && npm start"
ectl status
ectl ssh
ectl pull
ectl terminate
```

### B.4 Failed Deploy Recovery

```powershell
ectl deploy --run "npm run long-task"
# fails during push

ectl status          # see instance still running, status: failed
ectl ssh             # debug manually
ectl terminate       # cleanup when done
```

### B.5 JSON Output (Scripting)

```powershell
ectl status --json | ConvertFrom-Json
```

---

*End of SRS v1.0*
