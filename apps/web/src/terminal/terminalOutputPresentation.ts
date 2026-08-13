export interface GitHubActionsLogPresentation {
  readonly kind: "github-actions-log";
  readonly title: string;
  readonly command: string;
}

export type TerminalOutputPresentation = GitHubActionsLogPresentation;

export const GITHUB_ACTIONS_SNAPSHOT_BEGIN = "::T3S::";
export const GITHUB_ACTIONS_SNAPSHOT_END = "::T3E::";
export const GITHUB_ACTIONS_JOB = "::T3J::";
export const GITHUB_ACTIONS_STEP = "::T3P::";
export const GITHUB_ACTIONS_LOG_BEGIN = "::T3L::";

const ANSI_ESCAPE = new RegExp(`${"\x1b"}\\[[0-?]*[ -/]*[@-~]`, "gu");
const TIMESTAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/u;
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/** GitHub's log endpoint may prefix the first line with a UTF-8 byte-order mark. */
function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * The terminal background follows the app theme (near-white in light mode,
 * near-black in dark mode), so structural chrome uses only `dim`/`bold` —
 * attributes rendered relative to the themed foreground — and semantic color
 * is limited to four mid-lightness 256-color tones that keep readable
 * contrast on both backgrounds:
 *
 *   green 29 (#00875f) success   — ~4.6:1 on white, ~4.4:1 on near-black
 *   red 167 (#d75f5f)  errors    — ~3.7:1 on white, ~4.5:1 on near-black
 *   amber 172 (#d78700) warnings — paired with a bold glyph for recognition
 *   blue 68 (#5f87d7)  notices and command chevrons
 */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  hideCursor: "\x1b[?25l",
  clear: "\x1b[2J\x1b[3J\x1b[H",
  green: "\x1b[38;5;29m",
  red: "\x1b[38;5;167m",
  amber: "\x1b[38;5;172m",
  blue: "\x1b[38;5;68m",
} as const;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function workflowCommandContent(line: string, command: string): string | null {
  const hashPrefix = `##[${command}]`;
  if (line.startsWith(hashPrefix)) return line.slice(hashPrefix.length).trim();

  const colonPrefix = `::${command}`;
  if (!line.startsWith(colonPrefix)) return null;
  const markerEnd = line.indexOf("::", colonPrefix.length);
  return markerEnd < 0 ? "" : line.slice(markerEnd + 2).trim();
}

function runnerCommandContent(line: string): string | null {
  const workflowCommand = workflowCommandContent(line, "command");
  if (workflowCommand !== null) return workflowCommand;
  const runnerPrefix = "[command]";
  return line.startsWith(runnerPrefix) ? line.slice(runnerPrefix.length).trim() : null;
}

function timestampLabel(timestamp: string): string {
  return timestamp.slice(11, 19);
}

/**
 * Rails for the enclosing groups only. Depth is capped at three so deeply
 * nested composite actions cannot eat the narrow panel's width.
 */
function enclosingRails(depth: number): string {
  return "│ ".repeat(Math.min(depth, 3));
}

/** Rail prefix for lines inside a group; a two-space gutter at top level. */
function lineRail(depth: number): string {
  return depth === 0 ? "  " : enclosingRails(depth);
}

interface GitHubActionsJobSnapshot {
  readonly status: string;
  readonly conclusion: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

interface GitHubActionsStepSnapshot extends GitHubActionsJobSnapshot {
  readonly name: string;
}

interface GitHubActionsSnapshot {
  job: GitHubActionsJobSnapshot | null;
  steps: GitHubActionsStepSnapshot[];
}

function decodeTsvField(value: string): string {
  return value.replace(/\\([\\tnr])/gu, (_match, escaped: string) => {
    if (escaped === "t") return "\t";
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    return "\\";
  });
}

function snapshotFields(line: string): string[] {
  return line.split("\t").map(decodeTsvField);
}

function elapsedLabel(startedAt: string, completedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  const completed = completedAt.length > 0 ? Date.parse(completedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return "";

  const seconds = Math.max(0, Math.floor((completed - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    // Seconds stay visible below the hour so the running step's measure moves
    // on every three-second snapshot: that change is the liveness cue, which is
    // why this view needs no spinner.
    const remainingSeconds = seconds % 60;
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  // Trim before the ellipsis so a cut that lands on a word gap does not leave
  // the mark floating away from the text.
  return `${value.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

/**
 * Step names come from workflow YAML by way of a TSV field, so escaped tabs and
 * newlines can survive decoding. Flatten them to one line before any column
 * width is measured against them.
 */
function stepNameText(value: string): string {
  const flattened = stripAnsi(value).replace(CONTROL_CHARACTERS, " ");
  return flattened.replace(/ {2,}/gu, " ").trim();
}

function isSkippedStep(step: GitHubActionsStepSnapshot): boolean {
  return (
    step.status === "completed" && (step.conclusion === "skipped" || step.conclusion === "neutral")
  );
}

function isFailedStep(step: GitHubActionsStepSnapshot): boolean {
  return step.status === "completed" && step.conclusion !== "success" && !isSkippedStep(step);
}

function snapshotStatus(job: GitHubActionsJobSnapshot): {
  readonly color: string;
  readonly glyph: string;
  readonly label: string;
} {
  if (job.status !== "completed") {
    return job.status === "in_progress"
      ? { color: ANSI.blue, glyph: "●", label: "Running" }
      : { color: ANSI.amber, glyph: "○", label: "Queued" };
  }
  if (job.conclusion === "success") {
    return { color: ANSI.green, glyph: "✓", label: "Passed" };
  }
  if (job.conclusion === "skipped" || job.conclusion === "neutral") {
    return { color: ANSI.dim, glyph: "−", label: "Skipped" };
  }
  return { color: ANSI.red, glyph: "✕", label: "Failed" };
}

/**
 * One step row. `marker` colors the left edge bar that points at the step doing
 * work right now — the single loudest mark in the view — and stays empty for
 * every settled or not-yet-started step so finished work recedes.
 */
interface LiveStepRow {
  readonly marker: string;
  readonly glyph: string;
  readonly glyphColor: string;
  readonly nameStyle: string;
  readonly name: string;
  readonly duration: string;
}

function liveStepRow(step: GitHubActionsStepSnapshot, now: number): LiveStepRow {
  const name = stepNameText(step.name);
  const duration = elapsedLabel(step.startedAt, step.completedAt, now);
  if (step.status === "in_progress") {
    // The only bold, undimmed name in the list.
    return {
      marker: ANSI.blue,
      glyph: "●",
      glyphColor: ANSI.blue,
      nameStyle: ANSI.bold,
      name,
      duration,
    };
  }
  if (step.status !== "completed") {
    // A step that has not started has nothing to measure, and an empty cell
    // says so more quietly than the word "waiting" repeated down a column.
    return {
      marker: "",
      glyph: "○",
      glyphColor: ANSI.dim,
      nameStyle: ANSI.dim,
      name,
      duration: "",
    };
  }
  if (step.conclusion === "success") {
    return { marker: "", glyph: "✓", glyphColor: ANSI.green, nameStyle: ANSI.dim, name, duration };
  }
  // Skipped steps are filtered out before rows are built, so anything settled
  // and not successful failed: bar, glyph, and name all carry it.
  return {
    marker: ANSI.red,
    glyph: "✕",
    glyphColor: ANSI.red,
    nameStyle: `${ANSI.bold}${ANSI.red}`,
    name,
    duration,
  };
}

/**
 * Live monitor geometry. Both column widths are measured from the rows actually
 * on screen, so a job with short step names renders as a tight block rather
 * than a fixed-width report, while the caps keep a long-named job inside a
 * narrow panel instead of wrapping every row.
 */
const STEP_ROW_LIMIT = 12;
const STEP_NAME_MIN_WIDTH = 10;
const STEP_NAME_MAX_WIDTH = 34;
const STEP_DURATION_MAX_WIDTH = 7;
const LIVE_GUTTER = "  ";

function renderStepRow(row: LiveStepRow, nameWidth: number, durationWidth: number): string {
  const marker = row.marker.length > 0 ? `${row.marker}▌${ANSI.reset} ` : LIVE_GUTTER;
  const glyph = `${row.glyphColor}${row.glyph}${ANSI.reset}`;
  const name = truncate(row.name, nameWidth);
  if (row.duration.length === 0) {
    // Nothing to align against, so the name is not padded and the row ends
    // where the words end.
    return `${marker}${glyph}  ${row.nameStyle}${name}${ANSI.reset}`;
  }
  const measure = row.duration.padStart(durationWidth);
  return `${marker}${glyph}  ${row.nameStyle}${name.padEnd(nameWidth)}${ANSI.reset}  ${ANSI.dim}${measure}${ANSI.reset}`;
}

/**
 * Rolled-up rows sit on the step grid so the column of glyphs never breaks.
 * They are always dim: a fold can only ever hide steps that already passed,
 * because the window is anchored on the first failure.
 */
function renderFoldedRow(text: string): string {
  return `${LIVE_GUTTER}${ANSI.dim}·${ANSI.reset}  ${ANSI.dim}${text}${ANSI.reset}`;
}

function countLabel(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * Chooses which slice of a long step list to show. The window is anchored on
 * the first failure, else on the running step, so the row the reader came for
 * is always on screen and a hundred-step job cannot scroll the headline out of
 * a short panel.
 */
function stepWindow(steps: readonly GitHubActionsStepSnapshot[]): {
  readonly start: number;
  readonly end: number;
} {
  if (steps.length <= STEP_ROW_LIMIT) return { start: 0, end: steps.length };
  const failedIndex = steps.findIndex(isFailedStep);
  const activeIndex = steps.findIndex((step) => step.status === "in_progress");
  const running = activeIndex >= 0 ? activeIndex : steps.length - 1;
  const anchor = failedIndex >= 0 ? failedIndex : running;
  // Three rows of what happens next stay visible below the anchor.
  const earliest = Math.max(0, anchor - (STEP_ROW_LIMIT - 4));
  const start = Math.min(earliest, steps.length - STEP_ROW_LIMIT);
  return { start, end: start + STEP_ROW_LIMIT };
}

/**
 * Secondary text for the headline. The job name already sits in the terminal
 * tab, so this carries only what the tab cannot: position in the run and time
 * spent.
 */
function headerDetails(
  job: GitHubActionsJobSnapshot,
  steps: readonly GitHubActionsStepSnapshot[],
  now: number,
): string[] {
  const details: string[] = [];
  const activeIndex = steps.findIndex((step) => step.status === "in_progress");
  if (job.status !== "completed") {
    details.push(
      activeIndex >= 0 ? `step ${activeIndex + 1} of ${steps.length}` : "waiting for a runner",
    );
  } else if (job.conclusion === "success" && steps.length > 0) {
    details.push(countLabel(steps.length, "step"));
  }
  const elapsed = elapsedLabel(job.startedAt, job.completedAt, now);
  if (elapsed.length > 0) details.push(elapsed);
  return details;
}

/**
 * Formats the raw text returned by GitHub's Actions job-log endpoint for a VT terminal.
 * It deliberately leaves ordinary shell output untouched so authentication and CLI failures
 * remain actionable rather than being hidden behind presentation code.
 *
 * Visual hierarchy, quiet to loud: dim timestamps and rails recede; group
 * starts are the only bold structural marks; color appears solely on
 * annotations (error, warning, notice) and command chevrons so semantics pop
 * at a glance. Ordinary lines keep the job's own ANSI colors verbatim.
 *
 * Before the log exists, the same surface shows a live monitor built from job
 * snapshots: one headline, one row per step, and a colored edge bar against the
 * step running right now. It repaints whole — no prompt, no spinner, no claim
 * of streaming — and is cleared the instant the real log starts, so the two
 * views read as one screen moving from summary to detail.
 */
export class GitHubActionsLogFormatter {
  private pending = "";
  private groupDepth = 0;
  private logStarted = false;
  private cursorHidden = false;
  private snapshot: GitHubActionsSnapshot | null = null;
  private acceptsSnapshots = true;

  constructor(
    private readonly command: string,
    private readonly now: () => number = Date.now,
  ) {}

  reset(): void {
    this.pending = "";
    this.groupDepth = 0;
    this.logStarted = false;
    this.cursorHidden = false;
    this.snapshot = null;
    this.acceptsSnapshots = true;
  }

  write(chunk: string): string {
    if (chunk.length === 0) return "";

    const input = this.pending + chunk;
    this.pending = "";
    let output = this.cursorHidden ? "" : ANSI.hideCursor;
    this.cursorHidden = true;
    let lineStart = 0;

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character !== "\n" && character !== "\r") continue;

      const line = input.slice(lineStart, index);
      let separator = character;
      if (character === "\r" && input[index + 1] === "\n") {
        separator = "\r\n";
        index += 1;
      }
      const formatted = this.formatLine(line);
      if (formatted !== null) output += formatted + separator;
      lineStart = index + 1;
    }

    this.pending = input.slice(lineStart);
    return output;
  }

  private formatLine(line: string): string | null {
    const normalizedLine = stripByteOrderMark(line);
    if (this.acceptsSnapshots && normalizedLine === GITHUB_ACTIONS_SNAPSHOT_BEGIN) {
      this.snapshot = { job: null, steps: [] };
      return null;
    }
    if (this.acceptsSnapshots && normalizedLine === GITHUB_ACTIONS_SNAPSHOT_END) {
      const snapshot = this.snapshot;
      this.snapshot = null;
      return snapshot === null ? null : this.formatSnapshot(snapshot);
    }
    if (this.acceptsSnapshots && normalizedLine === GITHUB_ACTIONS_LOG_BEGIN) {
      this.snapshot = null;
      this.groupDepth = 0;
      this.logStarted = false;
      return ANSI.clear;
    }
    if (this.snapshot !== null) {
      this.captureSnapshotLine(normalizedLine);
      return null;
    }

    const match = TIMESTAMPED_LINE.exec(normalizedLine);
    if (!match) {
      if (this.logStarted) return null;
      const plainLine = stripAnsi(normalizedLine);
      return plainLine.includes(this.command) ? null : line;
    }

    this.logStarted = true;
    this.acceptsSnapshots = false;

    const [, timestamp = "", rawContent = ""] = match;
    const content = stripAnsi(rawContent).trimEnd();
    const time = `${ANSI.dim}${timestampLabel(timestamp)}${ANSI.reset}`;

    const groupTitle = workflowCommandContent(content, "group");
    if (groupTitle !== null) {
      const rails = enclosingRails(this.groupDepth);
      this.groupDepth += 1;
      // The step boundary is the strongest structural mark: parent rails stay
      // dim while the cap and title share one bold stroke.
      return `${time}  ${ANSI.dim}${rails}${ANSI.reset}${ANSI.bold}┌─ ${groupTitle}${ANSI.reset}`;
    }

    if (workflowCommandContent(content, "endgroup") !== null) {
      this.groupDepth = Math.max(0, this.groupDepth - 1);
      return `${time}  ${ANSI.dim}${enclosingRails(this.groupDepth)}└─${ANSI.reset}`;
    }

    const error = workflowCommandContent(content, "error");
    if (error !== null) {
      return `${time}  ${ANSI.red}${ANSI.bold}✕ ${error}${ANSI.reset}`;
    }

    const warning = workflowCommandContent(content, "warning");
    if (warning !== null) {
      // Bold glyph, regular-weight message: one step quieter than an error.
      return `${time}  ${ANSI.amber}${ANSI.bold}▲${ANSI.reset}${ANSI.amber} ${warning}${ANSI.reset}`;
    }

    const notice = workflowCommandContent(content, "notice");
    if (notice !== null) {
      // Only the bullet carries color; notice text stays informational.
      return `${time}  ${ANSI.blue}●${ANSI.reset} ${notice}`;
    }

    const command = runnerCommandContent(content);
    if (command !== null) {
      return `${time}  ${ANSI.dim}${lineRail(this.groupDepth)}${ANSI.reset}${ANSI.blue}❯${ANSI.reset} ${ANSI.bold}${command}${ANSI.reset}`;
    }

    // Ordinary output: quiet gutter, then the job's own bytes — including any
    // embedded ANSI colors — exactly as emitted, with a trailing reset so a
    // line that opens a color cannot bleed into the next timestamp gutter.
    return `${time}  ${ANSI.dim}${lineRail(this.groupDepth)}${ANSI.reset}${rawContent}${ANSI.reset}`;
  }

  private captureSnapshotLine(line: string): void {
    const [
      kind,
      status = "",
      conclusion = "",
      nameOrStartedAt = "",
      startedOrCompleted = "",
      completedAt = "",
    ] = snapshotFields(line);
    if (kind === GITHUB_ACTIONS_JOB) {
      this.snapshot = {
        job: {
          status,
          conclusion,
          startedAt: nameOrStartedAt,
          completedAt: startedOrCompleted,
        },
        steps: this.snapshot?.steps ?? [],
      };
      return;
    }
    if (kind !== GITHUB_ACTIONS_STEP || this.snapshot === null) return;
    this.snapshot.steps.push({
      status,
      conclusion,
      name: nameOrStartedAt,
      startedAt: startedOrCompleted,
      completedAt,
    });
  }

  /**
   * Repaints the whole live monitor. Every snapshot clears the screen first, so
   * this view never accumulates the history the raw log is about to supply.
   */
  private formatSnapshot(snapshot: GitHubActionsSnapshot): string {
    const job = snapshot.job;
    if (job === null) return "";

    const now = this.now();
    const status = snapshotStatus(job);
    const joined = headerDetails(job, snapshot.steps, now).join(" · ");
    const detail = joined.length > 0 ? `${ANSI.dim} · ${joined}${ANSI.reset}` : "";
    const label = `${status.glyph} ${status.label}`;
    const headline = `${status.color}${ANSI.bold}${label}${ANSI.reset}${detail}`;

    // Skipped steps are real but never the story: they are counted under the
    // list instead of padding it out.
    const listed = snapshot.steps.filter((step) => !isSkippedStep(step));
    const skipped = snapshot.steps.length - listed.length;
    const { start, end } = stepWindow(listed);
    const rows = listed.slice(start, end).map((step) => liveStepRow(step, now));
    const nameWidth = Math.min(
      STEP_NAME_MAX_WIDTH,
      Math.max(STEP_NAME_MIN_WIDTH, ...rows.map((row) => row.name.length)),
    );
    const durationWidth = Math.min(
      STEP_DURATION_MAX_WIDTH,
      Math.max(0, ...rows.map((row) => row.duration.length)),
    );

    const body: string[] = [];
    if (start > 0) body.push(renderFoldedRow(countLabel(start, "earlier step")));
    body.push(...rows.map((row) => renderStepRow(row, nameWidth, durationWidth)));
    if (end < listed.length) {
      body.push(renderFoldedRow(countLabel(listed.length - end, "later step")));
    }
    if (skipped > 0) body.push(renderFoldedRow(`${countLabel(skipped, "step")} skipped`));
    if (body.length === 0) {
      body.push(
        `${LIVE_GUTTER}${ANSI.dim}Steps appear here as the runner picks them up.${ANSI.reset}`,
      );
    }

    const footer =
      job.status === "completed"
        ? "Opening the full log…"
        : "Full log opens here when the job finishes";

    const footerLine = `${ANSI.dim}${footer}${ANSI.reset}`;
    // The leading clear also leaves row one blank, which keeps the headline off
    // the panel's top edge.
    return [ANSI.clear, headline, "", ...body, "", footerLine].join("\r\n");
  }
}
