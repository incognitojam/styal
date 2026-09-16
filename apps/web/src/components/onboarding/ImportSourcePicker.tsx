import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, DatabaseIcon } from "lucide-react";
import { useId } from "react";

import { cn } from "../../lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";

export type ImportSource = "t3-code" | "agent-history";

interface ImportSourceCopy {
  /** Short name used in the chooser row. */
  readonly title: string;
  /** One line stating what this source brings over, shown in the chooser. */
  readonly summary: string;
  /** Heading for the source's own screen. */
  readonly heading: string;
  /** What the user does next on the source's own screen. */
  readonly detail: string;
}

const IMPORT_SOURCE_COPY: Readonly<Record<ImportSource, ImportSourceCopy>> = {
  "t3-code": {
    title: "T3 Code data",
    summary:
      "Your projects, conversations, and preferences from a T3 installation on your selected computers.",
    heading: "Import from T3 Code",
    detail:
      "Pick the computer to import from, then choose the projects and preferences to bring over.",
  },
  "agent-history": {
    title: "Claude Code and Codex history",
    summary:
      "Projects and conversations already in your Claude Code and Codex command-line history.",
    heading: "Import from Claude Code and Codex",
    detail: "Choose the projects to bring in from each of your selected computers.",
  },
};

/** Order is deliberate: the T3 Code path carries the most data, so it leads. */
const IMPORT_SOURCE_ORDER: readonly ImportSource[] = ["t3-code", "agent-history"];

function ImportSourceMark({
  source,
  className,
}: {
  readonly source: ImportSource;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted/40",
        className,
      )}
    >
      {source === "t3-code" ? (
        <DatabaseIcon className="size-4.5 text-foreground/80" />
      ) : (
        <span className="flex items-center gap-1">
          <ClaudeAI className="size-3.5" />
          <OpenAI className="size-3.5 fill-foreground" />
        </span>
      )}
    </span>
  );
}

function ImportSourceOption({
  source,
  autoFocus = false,
  disabled,
  onSelect,
}: {
  readonly source: ImportSource;
  readonly autoFocus?: boolean;
  readonly disabled: boolean;
  readonly onSelect: (source: ImportSource) => void;
}) {
  const copy = IMPORT_SOURCE_COPY[source];
  const titleId = useId();
  const summaryId = useId();
  return (
    <Button
      variant="ghost"
      autoFocus={autoFocus}
      disabled={disabled}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      onClick={() => onSelect(source)}
      className="group h-auto min-h-14 w-full justify-start gap-3 rounded-lg border-border bg-background px-3 py-3 text-left whitespace-normal sm:h-auto"
    >
      <ImportSourceMark source={source} />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span id={titleId} className="block text-sm font-medium text-foreground">
          {copy.title}
        </span>
        <span id={summaryId} className="block text-xs leading-relaxed text-muted-foreground">
          {copy.summary}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
    </Button>
  );
}

/**
 * Step body for the projects step: state what can come over, offer the two
 * sources, and let the user finish without importing anything.
 */
export function ImportSourcePicker({
  disabled,
  onSelect,
  onContinue,
}: {
  /** True while an import is running; every action here waits for it. */
  readonly disabled: boolean;
  readonly onSelect: (source: ImportSource) => void;
  readonly onContinue: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Import your projects
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose a source to see what can come over. You can import from both.
      </p>
      <ul className="mt-5 space-y-2">
        {IMPORT_SOURCE_ORDER.map((source, index) => (
          <li key={source} className="min-w-0">
            <ImportSourceOption
              source={source}
              autoFocus={index === 0}
              disabled={disabled}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-x-4 gap-y-3">
        <p className="min-w-48 flex-1 text-xs leading-relaxed text-muted-foreground">
          Importing is optional. Continue when you’re ready to finish setup.
        </p>
        <Button disabled={disabled} onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

/**
 * Header for a single source screen. The importer body for that source renders
 * underneath it, so this stays to a back action, the heading, and one line of
 * orientation.
 */
export function ImportSourceHeader({
  source,
  disabled,
  onBack,
}: {
  readonly source: ImportSource;
  /** True while an import is running; going back would abandon it. */
  readonly disabled: boolean;
  readonly onBack: () => void;
}) {
  const copy = IMPORT_SOURCE_COPY[source];
  return (
    <header>
      <Button
        size="sm"
        variant="ghost-muted"
        disabled={disabled}
        onClick={onBack}
        className="-ml-2"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to import options
      </Button>
      <div className="mt-2.5 flex items-center gap-2.5">
        <ImportSourceMark source={source} className="size-8" />
        <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">
          {copy.heading}
        </h1>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.detail}</p>
    </header>
  );
}
