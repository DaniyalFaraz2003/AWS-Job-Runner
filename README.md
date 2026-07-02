# ectl

Project-local CLI to run long-lived tasks on AWS EC2. Configuration and state live in `.ectl/` beside your code — similar to how git uses `.git/`.

## Requirements

- Node.js 22+
- AWS credentials with EC2 permissions
- Windows PowerShell (v1 target platform)

## Install (development)

```powershell
npm install
npm run build
```

## Usage

```powershell
npx ectl --help
npx ectl init
```

Most commands are stubbed during early development. See [docs/SRS.md](docs/SRS.md) for requirements and GitHub issues for implementation phases.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run CLI via `tsx` without building |
| `npm run start` | Run compiled CLI |
| `npm run typecheck` | Typecheck without emit |
| `npm run test` | Run vitest |

## License

Private — internal use first, open source planned later.
