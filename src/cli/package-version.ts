import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Read version from package.json so `ectl --version` matches npm pack / publish. */
export function getPackageVersion(): string {
  const packageJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../package.json",
  );
  const pkg = require(packageJsonPath) as { version: string };
  return pkg.version;
}
