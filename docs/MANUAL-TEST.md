# ectl — Manual Test Checklist (Windows)

Use this checklist to verify ectl v1 on **Windows PowerShell** against a real AWS account with a default VPC. Complete each section in order unless noted.

**Prerequisites**

- [ ] Node.js 22+ installed (`node -v`)
- [ ] AWS credentials configured with EC2 permissions
- [ ] Default VPC exists with internet gateway and auto-assign public IP
- [ ] Repo built: `npm install && npm run build`

**Test project setup**

```powershell
cd $env:TEMP
Remove-Item -Recurse -Force ectl-manual-test -ErrorAction SilentlyContinue
mkdir ectl-manual-test
cd ectl-manual-test
npm init -y
```

Add a minimal `package.json` script for remote execution:

```powershell
@"
{
  "name": "ectl-manual-test",
  "scripts": {
    "start": "node -e \"const fs=require('fs'); fs.mkdirSync('output',{recursive:true}); fs.writeFileSync('output/result.txt', 'ok-' + Date.now()); console.log('done');\""
  }
}
"@ | Set-Content package.json
```

---

## 1. Global CLI

| Step | Command | Expected |
|------|---------|----------|
| 1.1 | `npx ectl --help` | Lists all 11 commands |
| 1.2 | `npx ectl --version` | Prints `0.0.0` |
| 1.3 | `npx ectl status` (outside project) | Error: no `.ectl/` — suggests `ectl init` |

- [ ] 1.1 pass
- [ ] 1.2 pass
- [ ] 1.3 pass

---

## 2. `ectl init`

| Step | Command | Expected |
|------|---------|----------|
| 2.1 | `npx ectl init` | Wizard prompts for region, instance type, AMI |
| 2.2 | Inspect files | `.ectl/config.json`, `.ectl/keys/ectl-key.pem`, `.ectlignore` exist |
| 2.3 | Check `.gitignore` | Contains `.ectl/` |
| 2.4 | `npx ectl init` again | Fails unless `--force` |
| 2.5 | `npx ectl init --json --region us-east-1 --instance-type t3.micro --ami-id <ami>` | JSON envelope with `ok: true` |

- [ ] 2.1 pass
- [ ] 2.2 pass
- [ ] 2.3 pass
- [ ] 2.4 pass
- [ ] 2.5 pass (optional)

**Verbose AWS logging**

```powershell
npx ectl init --verbose --force --region us-east-1 --instance-type t3.micro --ami-id <ami>
```

- [ ] `[verbose] AWS … (requestId=…)` lines appear on stderr

---

## 3. Configure artifacts

Edit `.ectl/config.json` — add `"artifactPaths": ["output/"]`.

- [ ] `artifactPaths` saved

---

## 4. Happy path — `ectl deploy`

| Step | Command | Expected |
|------|---------|----------|
| 4.1 | `npx ectl deploy --run "npm install && npm start"` | Three phases: launch, push, run |
| 4.2 | Note instance ID and public IP | Values match AWS console |
| 4.3 | `npx ectl status` | Table shows `running`, pm2 online |
| 4.4 | `npx ectl logs default --lines 20` | Shows app output |
| 4.5 | `npx ectl pull` | Files under `.ectl/logs/default/output/` |
| 4.6 | `npx ectl stop` | pm2 stopped, status `stopped` |
| 4.7 | `npx ectl terminate` | Instance terminated, SG deleted |
| 4.8 | `npx ectl status` | No active task (exit 0) |

- [ ] 4.1–4.8 pass

---

## 5. Step-by-step workflow

| Step | Command | Expected |
|------|---------|----------|
| 5.1 | `npx ectl launch` | Instance running |
| 5.2 | `npx ectl push` | Project uploaded |
| 5.3 | `npx ectl run --run "npm install && npm start"` | pm2 started |
| 5.4 | `npx ectl ssh` | Interactive shell (Ctrl+D to exit) |
| 5.5 | `npx ectl terminate` | Cleanup complete |

- [ ] 5.1–5.5 pass

---

## 6. Failure recovery

| Step | Command | Expected |
|------|---------|----------|
| 6.1 | `npx ectl deploy --run "exit 1"` | Deploy fails during run |
| 6.2 | Check output | Instance ID shown; recovery hints |
| 6.3 | AWS console | Instance still running |
| 6.4 | `npx ectl status` | Status `failed` |
| 6.5 | `npx ectl ssh` | Can connect |
| 6.6 | `npx ectl terminate` | Cleanup |

- [ ] 6.1–6.6 pass

---

## 7. Constraints and error messages

| Step | Command | Expected |
|------|---------|----------|
| 7.1 | Launch while task active | `ACTIVE_TASK_EXISTS` — suggests terminate |
| 7.2 | `npx ectl push` with no task | `NO_ACTIVE_TASK` |
| 7.3 | `npx ectl pull` with empty paths | `ARTIFACT_PATHS_EMPTY` |
| 7.4 | `npx ectl deploy` (no run cmd) | `RUN_COMMAND_MISSING` |

- [ ] 7.1–7.4 pass

---

## 8. JSON output

```powershell
npx ectl status --json | ConvertFrom-Json
```

- [ ] Envelope: `{ ok, command, data, error }`

---

## 9. Reconciliation

Terminate instance in AWS Console manually, then `npx ectl status` — local state should show `terminated`.

- [ ] 9 pass

---

## 10. Packaging

```powershell
npm run build
npm pack
```

- [ ] `ectl-0.0.0.tgz` created

---

## Sign-off

| Field | Value |
|-------|-------|
| Tester | |
| Date | |
| AWS region | |
| Node version | |
| ectl commit | |
| All sections pass | |
