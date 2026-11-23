// The Findings page (/workbench/findings/): every finding of the newest `workbench:check`, in one
// list, and the selected one played in the real workbench page.
//
// The right side holds the real workbench page in an iframe (`embed=1`, with `mark`), not a second
// renderer of the window: the seek, the replay under a still and the highlight are the workbench's
// own, so what this page shows is what "Open in workbench" shows, and the two cannot drift apart.
// Another occurrence in the same scene goes through the frame's `__workbenchPage.mark()`, so the
// workbench does not load again.
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { formatTime } from "../RunControls";
import type { WorkbenchPage } from "../Workbench";

type Loaded = { path: string; mtime: string; data: FindingsFile };
type Load =
  | { state: "loading" }
  | { state: "missing"; message: string }
  | { state: "failed"; message: string }
  | { state: "loaded"; value: Loaded };

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

/** True while the focus is in a field that takes typed keys. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
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

function KindChip({ kind }: { kind: FindingKind }) {
  return (
    <span className="fd-chip" data-kind={kind}>
      {KIND_LABELS[kind]}
    </span>
  );
}

/** The kind of a finding, and for a move its class: Shift under hand, Jitter or Expected. */
function Chips({ finding }: { finding: Finding }) {
  const movement = finding.movement;
  if (!movement) return <KindChip kind={finding.kind} />;
  return (
    <span className="fd-chip" data-class={movement.class}>
      {movement.class === "expected"
        ? `${KIND_LABELS[finding.kind]} · ${CLASS_LABELS.expected}`
        : CLASS_LABELS[movement.class]}
    </span>
  );
}

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
  const rowsRef = useRef<HTMLUListElement | null>(null);

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
      await navigator.clipboard.writeText(text);
      setCopied("Copied. Paste it into your agent.");
    } catch {
      setCopied("The browser did not let the page copy.");
    }
    setTimeout(() => setCopied(null), COPIED_MS);
  };

  const setField =
    <K extends keyof FindingFilter>(
      key: K,
      read: (v: string) => FindingFilter[K],
    ) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFilter((f) => ({ ...f, [key]: read(event.target.value) }));

  const filtered =
    filter.showExpected ||
    filter.kind !== "all" ||
    filter.window !== "all" ||
    filter.file !== "" ||
    filter.minSize > 0 ||
    filter.text.trim() !== "";

  return (
    <div className="fd-page">
      <aside className="wb-side fd-side">
        <nav className="wb-pages" aria-label="Workbench pages">
          <a href="/workbench/">Scenes</a>
          <span aria-current="page">Findings</span>
        </nav>
        <section className="fd-run" aria-label="The check">
          <div className="fd-run-line">
            <p className="fd-age">
              {loaded ? (
                <>
                  {`${loaded.data.sceneCount} scenes, checked `}
                  <time dateTime={loaded.mtime} title={loaded.mtime}>
                    {age(loaded.mtime, now)}
                  </time>
                </>
              ) : load.state === "loading" ? (
                "Loading findings…"
              ) : (
                "No check yet"
              )}
            </p>
            <button type="button" onClick={runCheck} disabled={running}>
              {running ? "Checking…" : "Run the check again"}
            </button>
          </div>
          {running && status && (
            <div className="fd-progress" role="status">
              <progress
                max={status.total || 1}
                value={status.total ? status.done : undefined}
              />
              <span>
                {status.total
                  ? `${status.done} of ${status.total} scenes`
                  : "Starting the check…"}
                {status.scene && (
                  <span className="wb-mono"> · {status.scene}</span>
                )}
              </span>
            </div>
          )}
          {!running &&
            status?.exitCode !== null &&
            status?.exitCode !== undefined &&
            status.exitCode !== 0 &&
            status.exitCode !== 1 && (
              <details className="fd-run-error" open>
                <summary>{`The check failed (code ${status.exitCode}).`}</summary>
                <pre>{status.stderr.join("\n")}</pre>
              </details>
            )}
          {runError && (
            <p className="fd-run-error" role="alert">
              {runError}
            </p>
          )}
        </section>

        <section className="fd-filters" aria-label="Filters">
          <input
            type="search"
            aria-label="Filter findings"
            placeholder="Filter findings"
            value={filter.text}
            onChange={setField("text", (v) => v)}
          />
          <label>
            <span>Kind</span>
            <select
              value={filter.kind}
              onChange={setField("kind", (v) => v as FindingFilter["kind"])}
            >
              <option value="all">All kinds</option>
              {FINDING_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Window</span>
            <select
              value={filter.window}
              onChange={setField("window", (v) => v as FindingFilter["window"])}
            >
              <option value="all">All windows</option>
              <option value="desktop">Setup window</option>
              <option value="app">App</option>
            </select>
          </label>
          <label>
            <span>File</span>
            <select value={filter.file} onChange={setField("file", (v) => v)}>
              <option value="">All files</option>
              {files.map((file) => (
                <option key={file} value={file}>
                  {file.replace(/^(desktop|app)\/src\//, "$1 · ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>At least</span>
            <span className="fd-px">
              <input
                type="number"
                min={0}
                step={1}
                value={filter.minSize}
                onChange={setField("minSize", (v) =>
                  Math.max(0, Number(v) || 0),
                )}
              />
              px
            </span>
          </label>
          <label>
            <span>Sort by</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as FindingSort)}
            >
              <option value="size">Size</option>
              <option value="scenes">Number of scenes</option>
              <option value="time">Time</option>
            </select>
          </label>
        </section>

        <label className="fd-expected">
          <input
            type="checkbox"
            checked={filter.showExpected}
            onChange={(e) =>
              setFilter((f) => ({ ...f, showExpected: e.target.checked }))
            }
          />
          {`Show expected moves (${expectedCount})`}
        </label>
        <p className="fd-hint">
          Expected moves come after an input, on a new screen or while a screen
          loads. Shown by default: shift under hand, jitter, cut off, outside,
          spacing and run problems.
        </p>
        <p className="fd-hint" data-spacing-rule>
          <strong>Spacing</strong>
          {`: ${SPACING_RULE} Why: ${SPACING_WHY}`}
        </p>

        <div className="fd-count">
          <span>
            {loaded
              ? shown.length === all.length
                ? `${all.length} findings`
                : `${shown.length} of ${all.length} findings`
              : ""}
          </span>
          {filtered && (
            <button
              type="button"
              className="wb-link-button"
              onClick={() => setFilter(NO_FILTER)}
            >
              Clear the filters
            </button>
          )}
        </div>

        {load.state === "missing" || load.state === "failed" ? (
          <p className="fd-empty">{load.message}</p>
        ) : loaded && all.length === 0 ? (
          <p className="fd-empty">The check found nothing.</p>
        ) : loaded && shown.length === 0 ? (
          <p className="fd-empty">No finding matches the filters.</p>
        ) : (
          <ul className="fd-rows" ref={rowsRef} aria-label="Findings">
            {shown.map((f) => {
              const file = f.component?.file;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    className="fd-row"
                    data-finding-id={f.id}
                    aria-current={f.id === selected?.id ? "true" : undefined}
                    onClick={() => pick(f.id)}
                  >
                    <span className="fd-row-title">{f.title}</span>
                    <span className="fd-row-meta">
                      <Chips finding={f} />
                      <span className="fd-size">{sizeText(f)}</span>
                      <span>{scenesText(f)}</span>
                      {file && (
                        <span
                          className="fd-file wb-mono"
                          title={fileLine(f) ?? file}
                        >
                          {baseName(file)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="fd-keys">
          <kbd>j</kbd> <kbd>k</kbd> findings · <kbd>←</kbd> <kbd>→</kbd>{" "}
          occurrences
        </p>
      </aside>

      <main className="fd-detail">
        {selected && occurrence && loaded ? (
          <>
            <header className="fd-head">
              <h1>{selected.title}</h1>
              <p className="fd-head-meta">
                <Chips finding={selected} />
                <span className="fd-size">{sizeText(selected)}</span>
                <span>
                  {`${scenesText(selected)}, ${selected.occurrences.length} ${selected.occurrences.length === 1 ? "time" : "times"}`}
                </span>
                {fileLine(selected) ? (
                  <span className="wb-mono" title={selected.component?.name}>
                    {fileLine(selected)}
                  </span>
                ) : isLayoutKind(selected.kind) ? (
                  <span className="fd-muted">No component file found</span>
                ) : null}
              </p>
              {selected.kind === "spacing" && (
                <p className="fd-why" data-rule="spacing">
                  <strong>{KIND_LABELS.spacing}</strong>
                  {`: ${SPACING_RULE} ${SPACING_WHY}`}
                </p>
              )}
              {movement && (
                <p className="fd-why" data-rule={movement.rule}>
                  <strong>{RULE_LABELS[movement.rule]}</strong>
                  {`: ${movement.why}`}
                </p>
              )}
            </header>
            <div className="fd-bar">
              <div className="fd-step">
                <button
                  type="button"
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
                </button>
                <span
                  className="fd-step-text"
                  data-occurrence={occurrenceIndex}
                >
                  {`${occurrenceIndex + 1} of ${occurrences.length}`}
                </span>
                <button
                  type="button"
                  aria-keyshortcuts="ArrowRight"
                  onClick={() =>
                    setIndex((occurrenceIndex + 1) % occurrences.length)
                  }
                  disabled={occurrences.length < 2}
                >
                  Next
                </button>
              </div>
              <span className="fd-where">
                {occurrence.scene.title}
                <span className="wb-time"> {formatTime(occurrence.at)}</span>
              </span>
              <span className="fd-actions">
                {copied && (
                  <span className="fd-muted" role="status">
                    {copied}
                  </span>
                )}
                <button type="button" onClick={copyPrompt}>
                  Copy as prompt
                </button>
                <a
                  className="fd-open"
                  href={`/workbench/?${occurrenceQuery(occurrence, loaded.data.window)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in workbench
                </a>
              </span>
            </div>
            {occurrences.length > 1 && (
              <ol className="fd-occurrences" aria-label="Occurrences">
                {occurrences.map((o, i) => (
                  // The scene, the time and the warning with its boxes name one occurrence.
                  <li
                    key={`${o.scene.id}|${o.at}|${JSON.stringify(o.warning ?? o.label)}`}
                  >
                    <button
                      type="button"
                      aria-current={i === occurrenceIndex ? "true" : undefined}
                      onClick={() => setIndex(i)}
                    >
                      <span>{o.scene.title}</span>
                      <span className="wb-time">{formatTime(o.at)}</span>
                      {o.warning?.kind === "moved" && o.warning.cause && (
                        <span className="fd-muted">{o.warning.cause}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {!occurrence.warning && (
              <p className="fd-message wb-mono">{occurrence.label}</p>
            )}
            {frameSrc && (
              <iframe
                ref={frameRef}
                className="fd-frame"
                title="The scene in the workbench"
                src={frameSrc}
                data-findings-frame=""
              />
            )}
          </>
        ) : (
          <p className="fd-empty fd-detail-empty">
            {load.state === "loading"
              ? "Loading findings…"
              : "Pick a finding to see it in its scene."}
          </p>
        )}
      </main>
    </div>
  );
}
