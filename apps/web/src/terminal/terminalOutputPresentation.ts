export interface GitHubActionsLogPresentation {
  readonly kind: "github-actions-log";
  readonly title: string;
  readonly command: string;
}

export type TerminalOutputPresentation = GitHubActionsLogPresentation;

const ANSI_ESCAPE = new RegExp(`${"\u001b"}\\[[0-?]*[ -/]*[@-~]`, "gu");
const TIMESTAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/u;

/** GitHub's log endpoint may prefix the first line with a UTF-8 byte-order mark. */
function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * The terminal background follows the app theme (near-white in light mode,
 * near-black in dark mode), so structural chrome uses only `dim`/`bold` —
 * attributes rendered relative to the themed foreground — and semantic color
 * is limited to three mid-lightness 256-color tones that keep readable
 * contrast on both backgrounds:
 *
 *   red 167 (#d75f5f)  errors    — ~3.7:1 on white, ~4.5:1 on near-black
 *   amber 172 (#d78700) warnings — paired with a bold glyph for recognition
 *   blue 68 (#5f87d7)  notices and command chevrons
 */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  hideCursor: "\x1b[?25l",
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

/**
 * Formats the raw text returned by GitHub's Actions job-log endpoint for a VT terminal.
 * It deliberately leaves ordinary shell output untouched so authentication and CLI failures
 * remain actionable rather than being hidden behind presentation code.
 *
 * Visual hierarchy, quiet to loud: dim timestamps and rails recede; group
 * starts are the only bold structural marks; color appears solely on
 * annotations (error, warning, notice) and command chevrons so semantics pop
 * at a glance. Ordinary lines keep the job's own ANSI colors verbatim.
 */
export class GitHubActionsLogFormatter {
  private pending = "";
  private groupDepth = 0;
  private logStarted = false;
  private cursorHidden = false;

  constructor(private readonly command: string) {}

  reset(): void {
    this.pending = "";
    this.groupDepth = 0;
    this.logStarted = false;
    this.cursorHidden = false;
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
    const match = TIMESTAMPED_LINE.exec(normalizedLine);
    if (!match) {
      if (this.logStarted) return null;
      const plainLine = stripAnsi(normalizedLine);
      return plainLine.includes(this.command) ? null : line;
    }

    this.logStarted = true;

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
}
