import {
  type ComponentProps,
  type ReactNode,
  type SVGProps,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ControlsConfig,
  type CSVSeparator,
  StreamdownContext,
  tableDataToCSV,
  tableDataToTSV,
  defaultTranslations as words,
} from "streamdown";
import { cn } from "@/lib/utils";

/**
 * A table in a Bot's markdown, drawn as Streamdown draws one, whose Copy and Download keep its links.
 *
 * WHY OURS. Streamdown's table controls read the drawn table's text, so a link came out as its words
 * alone: asked for a table of links, a person downloaded `| Release | OpenBot release notes |` and
 * lost every address in it (reported on 1.2.0-rc.4). Streamdown 2.8.1, its newest release, still
 * reads the text only, and its controls take no way to say how a cell is written out. So the table
 * is drawn here: the same wrapper, buttons, menus, icons and fullscreen view, class for class, with
 * a link written as `[words](address)` in Markdown and as `words (address)` in CSV and TSV.
 *
 * Everything else follows Streamdown's own table: the `controls` and `tableMaxHeight` a caller
 * gives Streamdown, the buttons held while a reply is still arriving, and the copy's rich form,
 * which is the table itself and so kept its links all along.
 */

/** Marks a part of a cell that is drawn but is not its content, like a document chip's "Doc". */
export const TABLE_EXPORT_SKIP = { "data-table-export": "skip" } as const;

type Format = "markdown" | "csv" | "tsv";

/** A cell, written for Markdown and as plain text for CSV and TSV. */
type Cell = { markdown: string; text: string };

/** A link's words: its text, with anything marked as not content left out. */
function linkWords(link: Element): string {
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (node.nodeType !== Node.ELEMENT_NODE) return;
    else if ((node as Element).hasAttribute("data-table-export")) return;
    else if (node.nodeName === "BR") text += " ";
    else node.childNodes.forEach(walk);
  };
  link.childNodes.forEach(walk);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A link in Markdown. A bare address is written as an autolink; anything else as `[words](address)`,
 * with the address in angle brackets when a space or a bracket in it would end it early.
 */
function markdownLink(text: string, address: string): string {
  if (text === address && !/[\s<>]/.test(address)) return `<${address}>`;
  const label = text.replace(/[\\[\]]/g, "\\$&");
  const destination = /[\s()<>]/.test(address)
    ? `<${address.replace(/[<>]/g, encodeURIComponent)}>`
    : address;
  return `[${label}](${destination})`;
}

function readCell(cell: Element): Cell {
  let markdown = "";
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      markdown += value.replace(/\\/g, "\\\\");
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.hasAttribute("data-table-export")) return;
    if (element.nodeName === "BR") {
      markdown += "\n";
      text += "\n";
      return;
    }
    // The address the link opens, written in full: a page of the app is a path on screen, and a file
    // is read somewhere else, where only the whole address leads back.
    const address =
      element instanceof HTMLAnchorElement && element.getAttribute("href")
        ? element.href
        : null;
    if (address) {
      const said = linkWords(element);
      markdown += markdownLink(said, address);
      text += said === address ? address : `${said} (${address})`;
      return;
    }
    element.childNodes.forEach(walk);
  };
  cell.childNodes.forEach(walk);
  return {
    // A pipe would end the cell, and a line ending the row; Streamdown writes them the same way.
    markdown: markdown.trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>"),
    text: text.trim(),
  };
}

function readTable(table: HTMLTableElement) {
  const headers = [...table.querySelectorAll("thead th")].map(readCell);
  const rows = [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map(readCell),
  );
  return { headers, rows };
}

function toMarkdown(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(headers),
    line(headers.map(() => "---")),
    ...rows.map((row) =>
      line(
        row.length < headers.length
          ? headers.map((_, index) => row[index] ?? "")
          : row,
      ),
    ),
  ].join("\n");
}

/** The table, written out in a format, links and all. */
export function writeTable(
  table: HTMLTableElement,
  format: Format,
  separator: CSVSeparator = ",",
): string {
  const { headers, rows } = readTable(table);
  if (format === "markdown")
    return toMarkdown(
      headers.map((cell) => cell.markdown),
      rows.map((row) => row.map((cell) => cell.markdown)),
    );
  const data = {
    headers: headers.map((cell) => cell.text),
    rows: rows.map((row) => row.map((cell) => cell.text)),
  };
  return format === "csv"
    ? tableDataToCSV(data, separator)
    : tableDataToTSV(data);
}

/** Streamdown's reading of `controls` for one of the table's buttons. */
function shows(
  controls: ControlsConfig,
  button: "copy" | "download" | "fullscreen",
) {
  if (typeof controls === "boolean") return controls;
  const table = controls.table;
  if (table === false) return false;
  if (table === true || table === undefined) return true;
  return table[button] !== false;
}

function csvSeparator(controls: ControlsConfig): CSVSeparator {
  if (typeof controls !== "object" || typeof controls.table !== "object")
    return ",";
  return controls.table.csvSeparator ?? ",";
}

function filename(controls: ControlsConfig): string {
  if (typeof controls !== "object" || typeof controls.table !== "object")
    return "table";
  const download = controls.table.download;
  return typeof download === "object" && download.filename
    ? download.filename
    : "table";
}

/** Hands the browser a file to save, as Streamdown does: CSV with a byte-order mark for Excel. */
function save(name: string, content: string, type: string) {
  const blob = new Blob([type === "text/csv" ? `\uFEFF${content}` : content], {
    type,
  });
  const address = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = address;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(address);
}

/** The table a control belongs to: the one in its wrapper, drawn inline or full screen. */
function tableOf(element: Element | null): HTMLTableElement | null {
  return (
    element
      ?.closest('[data-streamdown="table-wrapper"]')
      ?.querySelector("table") ?? null
  );
}

/** A menu that closes on a press anywhere outside it, as Streamdown's do. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current && !event.composedPath().includes(ref.current))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return { open, setOpen, ref };
}

/*
 * Streamdown's class strings and icons, unchanged, so the table looks exactly as it did. The icons
 * are drawn at 16px except Copy's, as Streamdown draws them (it passes the others a `size` its
 * icons ignore).
 */
const BUTTON =
  "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const MENU =
  "absolute top-full right-0 z-20 mt-1 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg";
const MENU_ITEM =
  "w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40";

function Icon({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
  return (
    <svg
      aria-hidden="true"
      color="currentColor"
      height={16}
      strokeLinejoin="round"
      viewBox="0 0 16 16"
      width={16}
      {...props}
    >
      <path clipRule="evenodd" d={d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const ICONS = {
  check:
    "M15.5607 3.99999L15.0303 4.53032L6.23744 13.3232C5.55403 14.0066 4.44599 14.0066 3.76257 13.3232L4.2929 12.7929L3.76257 13.3232L0.969676 10.5303L0.439346 9.99999L1.50001 8.93933L2.03034 9.46966L4.82323 12.2626C4.92086 12.3602 5.07915 12.3602 5.17678 12.2626L13.9697 3.46966L14.5 2.93933L15.5607 3.99999Z",
  copy: "M2.75 0.5C1.7835 0.5 1 1.2835 1 2.25V9.75C1 10.7165 1.7835 11.5 2.75 11.5H3.75H4.5V10H3.75H2.75C2.61193 10 2.5 9.88807 2.5 9.75V2.25C2.5 2.11193 2.61193 2 2.75 2H8.25C8.38807 2 8.5 2.11193 8.5 2.25V3H10V2.25C10 1.2835 9.2165 0.5 8.25 0.5H2.75ZM7.75 4.5C6.7835 4.5 6 5.2835 6 6.25V13.75C6 14.7165 6.7835 15.5 7.75 15.5H13.25C14.2165 15.5 15 14.7165 15 13.75V6.25C15 5.2835 14.2165 4.5 13.25 4.5H7.75ZM7.5 6.25C7.5 6.11193 7.61193 6 7.75 6H13.25C13.3881 6 13.5 6.11193 13.5 6.25V13.75C13.5 13.8881 13.3881 14 13.25 14H7.75C7.61193 14 7.5 13.8881 7.5 13.75V6.25Z",
  download:
    "M8.75 1V1.75V8.68934L10.7197 6.71967L11.25 6.18934L12.3107 7.25L11.7803 7.78033L8.70711 10.8536C8.31658 11.2441 7.68342 11.2441 7.29289 10.8536L4.21967 7.78033L3.68934 7.25L4.75 6.18934L5.28033 6.71967L7.25 8.68934V1.75V1H8.75ZM13.5 9.25V13.5H2.5V9.25V8.5H1V9.25V14C1 14.5523 1.44771 15 2 15H14C14.5523 15 15 14.5523 15 14V9.25V8.5H13.5V9.25Z",
  maximize:
    "M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z",
  close:
    "M12.4697 13.5303L13 14.0607L14.0607 13L13.5303 12.4697L9.06065 7.99999L13.5303 3.53032L14.0607 2.99999L13 1.93933L12.4697 2.46966L7.99999 6.93933L3.53032 2.46966L2.99999 1.93933L1.93933 2.99999L2.46966 3.53032L6.93933 7.99999L2.46966 12.4697L1.93933 13L2.99999 14.0607L3.53032 13.5303L7.99999 9.06065L12.4697 13.5303Z",
};

function CopyMenu() {
  const { isAnimating, controls } = useContext(StreamdownContext);
  const { open, setOpen, ref } = useMenu();
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (format: Format) => {
    const table = tableOf(ref.current);
    if (!table || !navigator.clipboard?.write) return;
    try {
      const text = writeTable(table, format, csvSeparator(controls));
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          // The rich form is the table itself, which keeps its links as links.
          "text/html": new Blob([table.outerHTML], { type: "text/html" }),
        }),
      ]);
      setCopied(true);
      setOpen(false);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Couldn't copy the table:", error);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        className={BUTTON}
        disabled={isAnimating}
        onClick={() => setOpen(!open)}
        title={words.copyTable}
        type="button"
      >
        <Icon d={copied ? ICONS.check : ICONS.copy} height={14} width={14} />
      </button>
      {open ? (
        <div className={MENU}>
          <button
            className={MENU_ITEM}
            onClick={() => void copy("markdown")}
            title={words.copyTableAsMarkdown}
            type="button"
          >
            {words.tableFormatMarkdown}
          </button>
          <button
            className={MENU_ITEM}
            onClick={() => void copy("csv")}
            title={words.copyTableAsCsv}
            type="button"
          >
            {words.tableFormatCsv}
          </button>
          <button
            className={MENU_ITEM}
            onClick={() => void copy("tsv")}
            title={words.copyTableAsTsv}
            type="button"
          >
            {words.tableFormatTsv}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DownloadMenu() {
  const { isAnimating, controls } = useContext(StreamdownContext);
  const { open, setOpen, ref } = useMenu();

  const download = (format: "markdown" | "csv") => {
    const table = tableOf(ref.current);
    if (!table) return;
    const csv = format === "csv";
    save(
      `${filename(controls)}.${csv ? "csv" : "md"}`,
      writeTable(table, format, csvSeparator(controls)),
      csv ? "text/csv" : "text/markdown",
    );
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        className={BUTTON}
        disabled={isAnimating}
        onClick={() => setOpen(!open)}
        title={words.downloadTable}
        type="button"
      >
        <Icon d={ICONS.download} />
      </button>
      {open ? (
        <div className={MENU}>
          <button
            className={MENU_ITEM}
            onClick={() => download("csv")}
            title={words.downloadTableAsCsv}
            type="button"
          >
            {words.tableFormatCsv}
          </button>
          <button
            className={MENU_ITEM}
            onClick={() => download("markdown")}
            title={words.downloadTableAsMarkdown}
            type="button"
          >
            {words.tableFormatMarkdown}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Tables open full screen at once share one hold on the page's scrolling, as Streamdown's do. */
let scrollHolds = 0;

function holdScrolling() {
  scrollHolds += 1;
  if (scrollHolds === 1) document.body.style.overflow = "hidden";
  return () => {
    scrollHolds = Math.max(0, scrollHolds - 1);
    if (scrollHolds === 0) document.body.style.overflow = "";
  };
}

function Fullscreen({
  children,
  showCopy,
  showDownload,
}: {
  children: ReactNode;
  showCopy: boolean;
  showDownload: boolean;
}) {
  const { isAnimating } = useContext(StreamdownContext);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const release = holdScrolling();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      release();
    };
  }, [open]);

  return (
    <>
      <button
        className={BUTTON}
        disabled={isAnimating}
        onClick={() => setOpen(true)}
        title={words.viewFullscreen}
        type="button"
      >
        <Icon d={ICONS.maximize} />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={words.viewFullscreen}
              aria-modal="true"
              className="fixed inset-0 z-50 flex flex-col bg-background"
              data-streamdown="table-fullscreen"
              onClick={() => setOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              role="dialog"
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: only keeps a press inside the view from closing it, as Streamdown's does. */}
              <div
                className="flex h-full flex-col"
                data-streamdown="table-wrapper"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
              >
                <div className="flex items-center justify-end gap-1 p-4">
                  {showCopy ? <CopyMenu /> : null}
                  {showDownload ? <DownloadMenu /> : null}
                  <button
                    className="rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
                    onClick={() => setOpen(false)}
                    title={words.exitFullscreen}
                    type="button"
                  >
                    <Icon d={ICONS.close} />
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
                  <table
                    className="w-full border-collapse border border-border"
                    data-streamdown="table"
                  >
                    {children}
                  </table>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Streamdown's `tableMaxHeight`, as a CSS length, or nothing for no limit. */
function maxHeight(value: number | string | undefined): string | undefined {
  if (value === undefined || value === 0 || value === Number.POSITIVE_INFINITY)
    return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? `${value}px` : undefined;
  return value === "0" || value === "none" || value === "Infinity"
    ? undefined
    : value;
}

/** Within this many pixels of the bottom, a table still arriving keeps its newest row in view. */
const NEAR_BOTTOM = 8;

/**
 * A table held to a height follows its newest row while it arrives, unless the reader has scrolled
 * up in it, as Streamdown's does.
 */
function useFollowNewRows(
  arriving: boolean,
  held: boolean,
  content: ReactNode,
) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const wasArriving = useRef(false);
  useEffect(() => {
    const element = ref.current;
    if (!(element && held)) return;
    const onScroll = () => {
      atBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <
        NEAR_BOTTOM;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [held]);
  useEffect(() => {
    if (!arriving || !wasArriving.current) atBottom.current = true;
    wasArriving.current = arriving;
  }, [arriving]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new row is what moves it, and arrives as new content.
  useEffect(() => {
    const element = ref.current;
    if (element && held && arriving && atBottom.current)
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  }, [arriving, held, content]);
  return ref;
}

export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"table"> & { node?: unknown }) {
  const { controls, isAnimating, tableMaxHeight } =
    useContext(StreamdownContext);
  const height = maxHeight(tableMaxHeight);
  const scroller = useFollowNewRows(isAnimating, Boolean(height), children);
  const showCopy = shows(controls, "copy");
  const showDownload = shows(controls, "download");
  const showFullscreen = shows(controls, "fullscreen");

  return (
    <div
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      {showCopy || showDownload || showFullscreen ? (
        <div className="flex items-center justify-end gap-1">
          {showCopy ? <CopyMenu /> : null}
          {showDownload ? <DownloadMenu /> : null}
          {showFullscreen ? (
            <Fullscreen showCopy={showCopy} showDownload={showDownload}>
              {children}
            </Fullscreen>
          ) : null}
        </div>
      ) : null}
      <div
        className="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background"
        ref={scroller}
        style={height ? { maxHeight: height } : undefined}
      >
        <table
          className={cn("w-full divide-y divide-border", className)}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}
