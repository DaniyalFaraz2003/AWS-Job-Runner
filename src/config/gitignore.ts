const ECTL_GITIGNORE_ENTRY = ".ectl/";

function lineMatchesEctlEntry(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === ECTL_GITIGNORE_ENTRY ||
    trimmed === ".ectl" ||
    trimmed === "/.ectl/" ||
    trimmed === "/.ectl"
  );
}

/** Append `.ectl/` to gitignore content when missing (FR-INIT-8). */
export function appendEctlToGitignore(content: string): {
  readonly content: string;
  readonly updated: boolean;
} {
  const hasEntry = content.split(/\r?\n/).some(lineMatchesEctlEntry);
  if (hasEntry) {
    return { content, updated: false };
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  const prefix = needsLeadingNewline ? "\n" : "";
  return {
    content: `${content}${prefix}${ECTL_GITIGNORE_ENTRY}\n`,
    updated: true,
  };
}
