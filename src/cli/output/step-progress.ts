import chalk from "chalk";
import ora, { type Ora } from "ora";
import { formatElapsedMs } from "../../util/format-elapsed.js";

export { formatElapsedMs };

/** Persistent step-by-step CLI progress (NFR-5). */
export class StepProgressReporter {
  private spinner: Ora | null = null;
  private currentLabel = "";

  /** Print a section header before steps begin. */
  printHeader(title: string, subtitle?: string): void {
    console.log("");
    console.log(chalk.bold(title));
    if (subtitle !== undefined) {
      console.log(chalk.dim(subtitle));
    }
    console.log("");
  }

  /** Print a phase divider between step groups (e.g. deploy launch → push → run). */
  printSection(title: string): void {
    console.log("");
    console.log(chalk.bold.cyan(title));
  }

  beginStep(label: string): void {
    this.currentLabel = label;
    this.spinner = ora({
      text: label,
      color: "cyan",
      spinner: "dots",
    }).start();
  }

  updateStep(label: string): void {
    this.currentLabel = label;
    if (this.spinner !== null) {
      this.spinner.text = label;
    }
  }

  completeStep(detail?: string): void {
    const suffix =
      detail !== undefined && detail.length > 0
        ? chalk.dim(` · ${detail}`)
        : "";
    this.spinner?.succeed(`${this.currentLabel}${suffix}`);
    this.spinner = null;
    this.currentLabel = "";
  }

  failStep(message?: string): void {
    this.spinner?.fail(message ?? this.currentLabel);
    this.spinner = null;
    this.currentLabel = "";
  }

  /** Stop spinner without marking success/failure (e.g. before JSON output). */
  stop(): void {
    this.spinner?.stop();
    this.spinner = null;
    this.currentLabel = "";
  }
}
