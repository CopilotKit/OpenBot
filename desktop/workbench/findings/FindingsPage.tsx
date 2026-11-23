// The Findings page (/workbench/findings/): every finding of the newest `workbench:check`, in one
// list, and the selected one played in the real workbench page.
//
// The right side holds the real workbench page in an iframe (`embed=1`, with `mark`), not a second
// renderer of the window: the seek, the replay under a still and the highlight are the workbench's
// own, so what this page shows is what "Open in workbench" shows, and the two cannot drift apart.
// Another occurrence in the same scene goes through the frame's `__workbenchPage.mark()`, so the
// workbench does not load again.
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../clipboard";
import {
  CLASS_LABELS,
  FINDING_KINDS,
  FINDINGS_RUN_URL,
  FINDINGS_STATUS_URL,
  FINDINGS_URL,
  type Finding,
  type FindingFilter,
  type FindingKind,
  type FindingSort,
  type FindingsFile,
  filterFindings,
  findingFiles,
  findingPrompt,
  isExpected,
  isLayoutKind,
  KIND_LABELS,
  NO_FILTER,
  type Occurrence,
  occurrenceQuery,
  RULE_LABELS,
  SPACING_RULE,
  SPACING_WHY,
  sortFindings,
  warningMark,
} from "../findings";
import type { CheckStatus } from "../findingsServer";
import { isTextField, usesArrows } from "../keyTargets";
import { formatTime } from "../RunControls";
import type { WorkbenchPage } from "../Workbench";

type Loaded = { path: string; mtime: string; data: FindingsFile };
type Load =
  | { state: "loading" }
  | { state: "missing"; message: string }
  | { state: "failed"; message: string }
  | { state: "loaded"; value: Loaded };

const WINDOW_OPTIONS: { value: FindingFilter["window"]; label: string }[] = [
  { value: "all", label: "All windows" },
  { value: "desktop", label: "Setup window" },
  { value: "app", label: "App" },
];
const SORT_OPTIONS: { value: FindingSort; label: string }[] = [
  { value: "size", label: "Size" },
  { value: "scenes", label: "Number of scenes" },
  { value: "time", label: "Time" },
];
/** The File filter's "All files": the filter itself keeps an empty string. */
const ALL_FILES = "*";

const POLL_MS = 1000;
const AGE_TICK_MS = 30_000;
const COPIED_MS = 2000;

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function age(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function fileLine(f: Finding): string | null {
  const c = f.component;
  if (!c?.file) return null;
  return `${c.file}${c.line !== undefined ? `:${c.line}` : ""}`;
}

/**
 * True while the focus is in a field that takes typed keys, or in a control that uses the arrow
 * keys itself (a Select and its list), or on the checkbox.
 */
function typing(target: EventTarget | null): boolean {
  return (
    isTextField(target) ||
    usesArrows(target) ||
    (target as HTMLElement | null)?.getAttribute?.("role") === "checkbox"
  );
}

function readLink(): { finding: string | null; occurrence: number } {
  const params = new URLSearchParams(window.location.search);
  const n = Number(params.get("o") ?? "0");
  return {
    finding: params.get("finding"),
    occurrence: Number.isInteger(n) && n >= 0 ? n : 0,
  };
}

/*
 * The kind of a finding as a small label in the app's colors: solid for the run problems and a
 * shift under hand, tinted for the other problems, quiet for an expected move.
 */
const CHIP = "whitespace-nowrap rounded px-1.5 text-[11px]/4 font-semibold";
const CHIP_SOLID = "bg-destructive text-background";
const CHIP_TINTED = "bg-destructive/10 text-destructive";
const CHIP_QUIET = "bg-muted text-muted-foreground";
const RUN_PROBLEMS: readonly FindingKind[] = [
  "no-answer",
  "app-error",
  "stalled",
  "step",
];

function KindChip({ kind }: { kind: FindingKind }) {
  return (
    <span
      className={cn(
        CHIP,
        RUN_PROBLEMS.includes(kind) ? CHIP_SOLID : CHIP_TINTED,
      )}
      data-kind={kind}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

/** The kind of a finding, and for a move its class: Shift under hand, Jitter or Expected. */
function Chips({ finding }: { finding: Finding }) {
  const movement = finding.movement;
  if (!movement) return <KindChip kind={finding.kind} />;
  return (
    <span
      className={cn(
        CHIP,
        movement.class === "shift-under-hand"
          ? CHIP_SOLID
          : movement.class === "jitter"
            ? CHIP_TINTED
            : CHIP_QUIET,
      )}
      data-class={movement.class}
    >
      {movement.class === "expected"
        ? `${KIND_LABELS[finding.kind]} · ${CLASS_LABELS.expected}`
        : CLASS_LABELS[movement.class]}
    </span>
  );
}

/** A key, as the keys help draws it (KeysHelp.tsx). */
function Key({ children }: { children: string }) {
  return (
    <kbd className="min-w-5 rounded border bg-muted px-1 text-center font-mono text-[11px]">
      {children}
    </kbd>
  );
}

const TIME = "font-mono text-xs font-medium tabular-nums";
const MUTED = "text-xs text-muted-foreground";

function sizeText(f: Finding): string {
  return f.size === null ? "Run problem" : `${f.size} px`;
}

function scenesText(f: Finding): string {
  return f.sceneCount === 1 ? "in 1 scene" : `in ${f.sceneCount} scenes`;
}

export function FindingsPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [status, setStatus] = useState<CheckStatus | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FindingFilter>(NO_FILTER);
  const [sort, setSort] = useState<FindingSort>("size");
  const [link] = useState(readLink);
  const [selectedId, setSelectedId] = useState<string | null>(link.finding);
  const [index, setIndex] = useState(link.occurrence);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const rowsRef = useRef<HTMLTableSectionElement | null>(null);

  const fetchFindings = useCallback(async () => {
    try {
      const answer = await fetch(FINDINGS_URL, { cache: "no-store" });
      const body = (await answer.json()) as Loaded & { error?: string };
      if (answer.status === 404)
        setLoad({ state: "missing", message: body.error ?? "" });
      else if (!answer.ok)
        setLoad({
          state: "failed",
          message: body.error ?? `The server answered ${answer.status}.`,
        });
      else setLoad({ state: "loaded", value: body });
    } catch {
      setLoad({
        state: "failed",
        message:
          "The workbench server does not answer. Start it with `cd desktop && bun run workbench`.",
      });
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<CheckStatus | null> => {
    try {
      const answer = await fetch(FINDINGS_STATUS_URL, { cache: "no-store" });
      const next = (await answer.json()) as CheckStatus;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchFindings();
    void fetchStatus();
  }, [fetchFindings, fetchStatus]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // While a check runs, read its progress; when it ends, load what it wrote.
  const running = status?.running === true;
  useEffect(() => {
    if (!running) return;
    let stop = false;
    const timer = setInterval(async () => {
      const next = await fetchStatus();
      if (!stop && next && !next.running) {
        stop = true;
        clearInterval(timer);
        void fetchFindings();
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [running, fetchStatus, fetchFindings]);

  const runCheck = async () => {
    setRunError(null);
    try {
      const answer = await fetch(FINDINGS_RUN_URL, { method: "POST" });
      const body = (await answer.json()) as CheckStatus & {
        status?: CheckStatus;
        error?: string;
      };
      if (answer.status === 409 && body.status) setStatus(body.status);
      else if (!answer.ok)
        setRunError(body.error ?? `The server answered ${answer.status}.`);
      else setStatus(body);
    } catch {
      setRunError("The workbench server does not answer.");
    }
  };

  const loaded = load.state === "loaded" ? load.value : null;
  const all = loaded?.data.findings ?? [];
  const files = useMemo(() => findingFiles(all), [all]);
  const expectedCount = useMemo(
    () => all.filter((f) => isExpected(f.movement)).length,
    [all],
  );
  const shown = useMemo(
    () => sortFindings(filterFindings(all, filter), sort),
    [all, filter, sort],
  );
  const selected: Finding | null =
    shown.find((f) => f.id === selectedId) ?? shown[0] ?? null;
  const occurrences = selected?.occurrences ?? [];
  const occurrenceIndex = Math.min(index, Math.max(0, occurrences.length - 1));
  const occurrence: Occurrence | null = occurrences[occurrenceIndex] ?? null;
  /** The rule this occurrence hit, or the finding's when it has none of its own. */
  const movement = occurrence?.movement ?? selected?.movement ?? null;

  // The page's own link keeps the selected finding and occurrence.
  useEffect(() => {
    if (!selected) return;
    const params = new URLSearchParams(window.location.search);
    params.set("finding", selected.id);
    params.set("o", String(occurrenceIndex));
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [selected, occurrenceIndex]);

  // Opens the occurrence in the frame: in place when the frame shows its scene, else a new load.
  useEffect(() => {
    if (!occurrence || !loaded) return;
    const page = (
      frameRef.current?.contentWindow as
        | (Window & { __workbenchPage?: WorkbenchPage })
        | null
        | undefined
    )?.__workbenchPage;
    if (page?.ready && page.scene === occurrence.scene.id) {
      if (occurrence.warning) void page.mark(warningMark(occurrence.warning));
      else void page.seek(occurrence.at);
      return;
    }
    setFrameSrc(
      `/workbench/?${occurrenceQuery(occurrence, loaded.data.window, { embed: true })}`,
    );
  }, [occurrence, loaded]);

  const pick = (id: string) => {
    setSelectedId(id);
    setIndex(0);
  };

  const keysRef = useRef({ shown, selected, occurrences, occurrenceIndex });
  keysRef.current = { shown, selected, occurrences, occurrenceIndex };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      const k = keysRef.current;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        if (k.occurrences.length === 0) return;
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        setIndex(
          (k.occurrenceIndex + step + k.occurrences.length) %
            k.occurrences.length,
        );
      } else if (event.key === "j" || event.key === "k") {
        if (k.shown.length === 0) return;
        event.preventDefault();
        const at = k.selected ? k.shown.indexOf(k.selected) : -1;
        const next =
          event.key === "j"
            ? Math.min(k.shown.length - 1, at + 1)
            : Math.max(0, at - 1);
        const f = k.shown[next];
        if (f) {
          setSelectedId(f.id);
          setIndex(0);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The selected row stays in view when j and k move past the edge of the list.
  useEffect(() => {
    if (!selected) return;
    rowsRef.current
      ?.querySelector(`[data-finding-id="${selected.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const copyPrompt = async () => {
    if (!selected || !occurrence || !loaded) return;
    const text = findingPrompt(selected, occurrence, {
      window: loaded.data.window,
      origin: window.location.origin,
    });
    try {
      await copyText(text);
      setCopied("Copied. Paste it into your agent.");
    } catch {
      setCopied("The browser did not let the page copy.");
    }
    setTimeout(() => setCopied(null), COPIED_MS);
  };

  const setField =
    <K extends keyof FindingFilter>(key: K) =>
    (value: FindingFilter[K]) =>
      setFilter((f) => ({ ...f, [key]: value }));

  const filtered =
    filter.showExpected ||
    filter.kind !== "all" ||
    filter.window !== "all" ||
    filter.file !== "" ||
    filter.minSize > 0 ||
    filter.text.trim() !== "";

  const fileLabel = (file: string) =>
    file.replace(/^(desktop|app)\/src\//, "$1 · ");
  const kindLabel =
    filter.kind === "all" ? "All kinds" : KIND_LABELS[filter.kind];
  const windowLabel = WINDOW_OPTIONS.find(
    (o) => o.value === filter.window,
  )?.label;
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label;

  return (
    <div className="grid h-dvh grid-cols-[minmax(320px,420px)_minmax(0,1fr)] text-sm">
      <aside className="flex min-h-0 flex-col gap-3 overflow-hidden border-r p-3">
        <nav className="flex flex-none gap-1" aria-label="Workbench pages">
          <a
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            href="/workbench/"
          >
            Scenes
          </a>
          <span
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            aria-current="page"
          >
            Findings
          </span>
        </nav>
        <section className="grid flex-none gap-2" aria-label="The check">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {loaded ? (
                <>
                  {`${loaded.data.sceneCount} scenes, checked `}
                  <time
                    className="text-foreground"
                    dateTime={loaded.mtime}
                    title={loaded.mtime}
                  >
                    {age(loaded.mtime, now)}
                  </time>
                </>
              ) : load.state === "loading" ? (
                "Loading findings…"
              ) : (
                "No check yet"
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={runCheck}
              disabled={running}
            >
              {running ? "Checking…" : "Run the check again"}
            </Button>
          </div>
          {running && status && (
            <div className={cn("grid gap-1", MUTED)} role="status">
              <progress
                className="h-1 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
                max={status.total || 1}
                value={status.total ? status.done : undefined}
              />
              <span>
                {status.total
                  ? `${status.done} of ${status.total} scenes`
                  : "Starting the check…"}
                {status.scene && (
                  <span className="font-mono"> · {status.scene}</span>
                )}
              </span>
            </div>
          )}
          {!running &&
            status?.exitCode !== null &&
            status?.exitCode !== undefined &&
            status.exitCode !== 0 &&
            status.exitCode !== 1 && (
              <Collapsible
                defaultOpen
                className="rounded-lg bg-destructive/10 p-2"
              >
                <CollapsibleTrigger className="text-left font-medium">
                  {`The check failed (code ${status.exitCode}).`}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                    {status.stderr.join("\n")}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          {runError && (
            <p
              className="rounded-lg bg-destructive/10 p-2 text-destructive"
              role="alert"
            >
              {runError}
            </p>
          )}
        </section>

        <section
          className="grid flex-none grid-cols-2 gap-2"
          aria-label="Filters"
        >
          <Input
            type="search"
            className="col-span-2"
            aria-label="Filter findings"
            placeholder="Filter findings"
            value={filter.text}
            onChange={(e) => setField("text")(e.target.value)}
          />
          <div className="grid min-w-0 gap-1">
            <span className={MUTED}>Kind</span>
            <Select
              value={filter.kind}
              onValueChange={(v) =>
                setField("kind")(String(v) as FindingFilter["kind"])
              }
            >
              <SelectTrigger size="sm" aria-label="Kind" className="w-full">
                <SelectValue>{kindLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {FINDING_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-1">
            <span className={MUTED}>Window</span>
            <Select
              value={filter.window}
              onValueChange={(v) =>
                setField("window")(String(v) as FindingFilter["window"])
              }
            >
              <SelectTrigger size="sm" aria-label="Window" className="w-full">
                <SelectValue>{windowLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-1">
            <span className={MUTED}>File</span>
            <Select
              value={filter.file || ALL_FILES}
              onValueChange={(v) =>
                setField("file")(v === ALL_FILES ? "" : String(v))
              }
            >
              <SelectTrigger size="sm" aria-label="File" className="w-full">
                <SelectValue>
                  {filter.file ? fileLabel(filter.file) : "All files"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILES}>All files</SelectItem>
                {files.map((file) => (
                  <SelectItem key={file} value={file}>
                    {fileLabel(file)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Label className="grid min-w-0 gap-1 font-normal">
            <span className={MUTED}>At least</span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <Input
                type="number"
                className="h-7"
                min={0}
                step={1}
                value={filter.minSize}
                onChange={(e) =>
                  setField("minSize")(Math.max(0, Number(e.target.value) || 0))
                }
              />
              px
            </span>
          </Label>
          <div className="grid min-w-0 gap-1">
            <span className={MUTED}>Sort by</span>
            <Select
              value={sort}
              onValueChange={(v) => setSort(String(v) as FindingSort)}
            >
              <SelectTrigger size="sm" aria-label="Sort by" className="w-full">
                <SelectValue>{sortLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        <div className="flex-none">
          <Label className="text-sm">
            <Checkbox
              checked={filter.showExpected}
              onCheckedChange={(checked) => setField("showExpected")(checked)}
            />
            {`Show expected moves (${expectedCount})`}
          </Label>
          <p className={cn("mt-1 pl-6", MUTED)}>
            Expected moves come after an input, on a new screen or while a
            screen loads. Shown by default: shift under hand, jitter, cut off,
            outside, spacing and run problems.
          </p>
          <p className={cn("mt-1 pl-6", MUTED)} data-spacing-rule>
            <strong className="font-semibold text-foreground">Spacing</strong>
            {`: ${SPACING_RULE} Why: ${SPACING_WHY}`}
          </p>
        </div>

        <div className="flex min-h-5 flex-none items-center justify-between text-xs font-semibold">
          {loaded ? (
            <span data-finding-count="">
              {shown.length === all.length
                ? `${all.length} findings`
                : `${shown.length} of ${all.length} findings`}
            </span>
          ) : (
            <span />
          )}
          {filtered && (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={() => setFilter(NO_FILTER)}
            >
              Clear the filters
            </Button>
          )}
        </div>

        {load.state === "missing" || load.state === "failed" ? (
          <p className="text-muted-foreground">{load.message}</p>
        ) : loaded && all.length === 0 ? (
          <p className="text-muted-foreground">The check found nothing.</p>
        ) : loaded && shown.length === 0 ? (
          <p className="text-muted-foreground">
            No finding matches the filters.
          </p>
        ) : (
          <Table
            aria-label="Findings"
            className="table-fixed"
            containerClassName="min-h-0 flex-1"
          >
            <TableBody ref={rowsRef}>
              {shown.map((f) => {
                const file = f.component?.file;
                const current = f.id === selected?.id;
                return (
                  <TableRow
                    key={f.id}
                    data-class={f.movement?.class}
                    className={cn(current && "bg-muted hover:bg-muted")}
                  >
                    <TableCell className="px-2">
                      <div className="grid gap-1">
                        <Button
                          variant="link"
                          className="line-clamp-2 block h-auto whitespace-normal px-0 text-left font-medium text-foreground [overflow-wrap:anywhere]"
                          data-finding-id={f.id}
                          aria-current={current ? "true" : undefined}
                          onClick={() => pick(f.id)}
                        >
                          {f.title}
                        </Button>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <Chips finding={f} />
                          <span className="font-semibold text-foreground tabular-nums">
                            {sizeText(f)}
                          </span>
                          <span>{scenesText(f)}</span>
                          {file && (
                            <span
                              className="min-w-0 truncate font-mono"
                              title={fileLine(f) ?? file}
                            >
                              {baseName(file)}
                            </span>
                          )}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <p className={cn("flex-none", MUTED)}>
          <Key>j</Key> <Key>k</Key> findings · <Key>←</Key> <Key>→</Key>{" "}
          occurrences
        </p>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col gap-3 p-3">
        {selected && occurrence && loaded ? (
          <>
            <header className="grid flex-none gap-1">
              <h1 className="text-base font-semibold [overflow-wrap:anywhere]">
                {selected.title}
              </h1>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Chips finding={selected} />
                <span className="font-semibold text-foreground tabular-nums">
                  {sizeText(selected)}
                </span>
                <span>
                  {`${scenesText(selected)}, ${selected.occurrences.length} ${selected.occurrences.length === 1 ? "time" : "times"}`}
                </span>
                {fileLine(selected) ? (
                  <span className="font-mono" title={selected.component?.name}>
                    {fileLine(selected)}
                  </span>
                ) : isLayoutKind(selected.kind) ? (
                  <span>No component file found</span>
                ) : null}
              </p>
              {selected.kind === "spacing" && (
                <p className="text-muted-foreground" data-rule="spacing">
                  <strong className="font-semibold text-foreground">
                    {KIND_LABELS.spacing}
                  </strong>
                  {`: ${SPACING_RULE} ${SPACING_WHY}`}
                </p>
              )}
              {movement && (
                <p className="text-muted-foreground" data-rule={movement.rule}>
                  <strong className="font-semibold text-foreground">
                    {RULE_LABELS[movement.rule]}
                  </strong>
                  {`: ${movement.why}`}
                </p>
              )}
            </header>
            <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-keyshortcuts="ArrowLeft"
                  onClick={() =>
                    setIndex(
                      (occurrenceIndex - 1 + occurrences.length) %
                        occurrences.length,
                    )
                  }
                  disabled={occurrences.length < 2}
                >
                  Previous
                </Button>
                <span
                  className="min-w-14 text-center text-muted-foreground tabular-nums"
                  data-occurrence={occurrenceIndex}
                >
                  {`${occurrenceIndex + 1} of ${occurrences.length}`}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-keyshortcuts="ArrowRight"
                  onClick={() =>
                    setIndex((occurrenceIndex + 1) % occurrences.length)
                  }
                  disabled={occurrences.length < 2}
                >
                  Next
                </Button>
              </div>
              <span className="font-medium">
                {occurrence.scene.title}
                <span className={TIME}> {formatTime(occurrence.at)}</span>
              </span>
              <span className="ml-auto flex items-center gap-2">
                {copied && (
                  <span className={MUTED} role="status">
                    {copied}
                  </span>
                )}
                <Button size="sm" variant="outline" onClick={copyPrompt}>
                  Copy as prompt
                </Button>
                <a
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                  )}
                  href={`/workbench/?${occurrenceQuery(occurrence, loaded.data.window)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in workbench
                </a>
              </span>
            </div>
            {occurrences.length > 1 && (
              <ol
                className="flex max-h-22 flex-none flex-wrap gap-1 overflow-y-auto"
                aria-label="Occurrences"
              >
                {occurrences.map((o, i) => {
                  const current = i === occurrenceIndex;
                  return (
                    // The scene, the time and the warning with its boxes name one occurrence.
                    <li
                      key={`${o.scene.id}|${o.at}|${JSON.stringify(o.warning ?? o.label)}`}
                    >
                      <Button
                        size="xs"
                        variant={current ? "default" : "outline"}
                        className="font-normal"
                        aria-current={current ? "true" : undefined}
                        onClick={() => setIndex(i)}
                      >
                        <span>{o.scene.title}</span>
                        <span className={TIME}>{formatTime(o.at)}</span>
                        {o.warning?.kind === "moved" && o.warning.cause && (
                          <span
                            className={cn(
                              "text-xs",
                              !current && "text-muted-foreground",
                            )}
                          >
                            {o.warning.cause}
                          </span>
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
            {!occurrence.warning && (
              <p className="flex-none whitespace-pre-wrap rounded-lg border p-2 font-mono text-xs [overflow-wrap:anywhere]">
                {occurrence.label}
              </p>
            )}
            {frameSrc && (
              <iframe
                ref={frameRef}
                className="min-h-80 w-full flex-1 rounded-lg border"
                title="The scene in the workbench"
                src={frameSrc}
                data-findings-frame=""
              />
            )}
          </>
        ) : (
          <p className="m-auto text-muted-foreground">
            {load.state === "loading"
              ? "Loading findings…"
              : "Pick a finding to see it in its scene."}
          </p>
        )}
      </main>
    </div>
  );
}
