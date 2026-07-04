# Contributing to ectl

Thank you for your interest in contributing to **ectl**! This project is open source and welcomes issues, bug reports, and pull requests.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run checks before submitting:
   ```powershell
   npm run typecheck
   npm test
   ```

## Development workflow

- Follow existing patterns in `src/` — thin CLI commands, logic in services/orchestration.
- Read [`docs/SRS.md`](docs/SRS.md) for requirements and scope boundaries.
- See [`.cursor/rules/`](.cursor/rules/) for TypeScript, AWS SDK, and git conventions used in this repo.

## Pull requests

1. Create a feature branch from `main` (e.g. `feat/my-change`, `fix/bug-description`).
2. Keep PRs focused — one logical change per PR when possible.
3. Include a short summary, test plan, and link to any related GitHub issue.
4. Ensure CI passes (typecheck, tests, build).

## Reporting bugs

Open a [GitHub issue](https://github.com/DaniyalFaraz2003/AWS-Job-Runner/issues) with:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version, OS, and AWS region (if relevant)
- Redacted CLI output or error messages (never paste AWS keys or `.ectl/keys/` contents)

## Scope

v1 targets **Windows PowerShell** and a single active EC2 task per project. Features listed as out of scope in SRS §13.2 may be deferred — open an issue to discuss before large changes.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
