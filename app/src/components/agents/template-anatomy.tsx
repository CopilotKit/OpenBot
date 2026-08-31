import {
  IconChevronRight,
  IconCode,
  IconEye,
  IconFolder,
  IconPencil,
  IconPlugConnected,
  IconSparkles,
  IconTerminal2,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Verbatim } from "@/components/agents/template-prose";

/**
 * The scannable half of a template.
 *
 * A template's page is mostly a stranger's prose, and it has to stay that way: the text a model will
 * be given is the substance, and this feature's whole argument is that somebody reads it before
 * anything runs. But rendering EVERYTHING as prose made the page a wall — twenty-odd paragraphs of
 * monospace where the three questions people actually arrive with are cheap to answer and were
 * buried: what can it reach, what can it do, and what will it be told to do.
 *
 * So the facts that are structured data get drawn as structured data. Nothing here restates a
 * stranger's words in this repository's voice; every sentence an author wrote is still rendered
 * verbatim beside these, and everything below is derived from fields the format defines with a
 * closed vocabulary — which is exactly the part a person should be able to take in at a glance
 * rather than read.
 */

/**
 * A hue for one template, taken from its own seed.
 *
 * The gallery's problem is that every card used the same box icon, so twelve templates were twelve
 * identical rows and the eye had nothing to land on. The avatar solves that — `boring-avatars` draws
 * a different figure per seed — and this washes the same seed across the surface behind it so the
 * card is distinguishable before the drawing itself is legible.
 *
 * Deterministic and content-free. It is a hash of the seed, so the same template is the same colour
 * on every deployment and nothing about the colour means anything: it is not a category, not a
 * status, and not a signal about trust. A colour that meant something would be a colour a template's
 * author could choose, and every value on this card that an author chooses is labelled as a claim.
 */
export function hueFor(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

/** One fact about the template, sized to be read in passing rather than studied. */
export function Glance({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] text-muted-foreground leading-tight">
          {label}
        </span>
        {/*
         * WRAPS RATHER THAN TRUNCATES. These values are short by construction — a count, a category
         * label, a connector list — and an ellipsis on "Customer Success & Support" hides the half
         * that distinguishes it while saving nothing. A second line costs one row of height; a
         * truncated category costs the reader the answer they came for.
         */}
        <span className="block font-medium text-sm leading-tight">{value}</span>
      </span>
    </div>
  );
}

/*
 * The ceiling, as four levels rather than four sentences.
 *
 * `describeBoundary` remains the authority on the WORDING and is still rendered in full beside this,
 * because the consent screen and the Boundaries screen read a ceiling back from that one helper and
 * a second set of sentences is how those two drift apart. This is not a second set of sentences: it
 * is an index over the same object, in the format's own closed vocabulary, so a reader can see in one
 * pass which of the four capabilities are open before reading what that means.
 */
const LEVELS = {
  none: { label: "No", icon: IconX, tone: "text-muted-foreground" },
  read: { label: "Read only", icon: IconEye, tone: "text-foreground" },
  write: { label: "Read and write", icon: IconPencil, tone: "text-foreground" },
  full: { label: "Full", icon: IconPencil, tone: "text-foreground" },
} as const;

type LevelKey = keyof typeof LEVELS;

function Level({ level }: { level: LevelKey }) {
  const { label, icon: Icon, tone } = LEVELS[level];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] ${tone} ${
        level === "none" ? "bg-muted/50" : "bg-background"
      }`}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}

export type TemplateCeiling = {
  shell: string;
  files: string;
  browser: string;
  navigateHosts: string[];
  mcp: string;
};

export function CeilingGrid({ boundary }: { boundary: TemplateCeiling }) {
  const rows: {
    icon: ReactNode;
    name: string;
    level: LevelKey;
    detail?: string;
  }[] = [
    {
      icon: <IconTerminal2 aria-hidden className="size-4" />,
      name: "Shell commands",
      level: boundary.shell === "never" ? "none" : "full",
    },
    {
      icon: <IconFolder aria-hidden className="size-4" />,
      name: "Files",
      level:
        boundary.files === "none"
          ? "none"
          : boundary.files === "read_only"
            ? "read"
            : "write",
    },
    {
      icon: <IconWorld aria-hidden className="size-4" />,
      name: "The web",
      level:
        boundary.browser === "none"
          ? "none"
          : boundary.browser === "read_only"
            ? "read"
            : "full",
      /*
       * An empty host list is the ABSENCE of a limit, not a limit of none — the same trap the
       * sentence helper documents at length. Said here in the same direction, so the compact view
       * cannot read as the tightest ceiling while meaning the loosest.
       */
      detail:
        boundary.browser === "none"
          ? undefined
          : boundary.navigateHosts.length === 0
            ? "any site"
            : boundary.navigateHosts.join(", "),
    },
    {
      icon: <IconPlugConnected aria-hidden className="size-4" />,
      name: "Connector tools",
      level:
        boundary.mcp === "none"
          ? "none"
          : boundary.mcp === "read_only"
            ? "read"
            : "write",
    },
  ];

  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
      {rows.map((row) => (
        <li
          className="flex items-center justify-between gap-3 bg-card px-3 py-2.5"
          key={row.name}
        >
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            {row.icon}
            <span className="min-w-0">
              <span className="block text-foreground text-sm leading-tight">
                {row.name}
              </span>
              {row.detail ? (
                <span className="block truncate text-[11px] leading-tight">
                  {row.detail}
                </span>
              ) : null}
            </span>
          </span>
          <Level level={row.level} />
        </li>
      ))}
    </ul>
  );
}

/** A tool a skill names or an ask lists. Monospace because it is an identifier, not a word. */
export function ToolChip({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * One connector the author asked for, with the tools under it.
 *
 * The ask used to be a heading, a paragraph and a bulleted list per tool, which for a template
 * asking for two connectors and five tools was most of a screen. The author's reason is still here
 * word for word — it is the only part of this a stranger wrote — but the refs are chips, because a
 * tool ref is an identifier somebody scans for rather than a sentence they read.
 */
export function ConnectorAsk({
  id,
  why,
  tools,
}: {
  id: string;
  why: string;
  tools: { ref: string; why: string }[];
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconPlugConnected
          aria-hidden
          className="size-4 text-muted-foreground"
        />
        <span className="font-medium font-mono text-sm">{id}</span>
        <span className="text-[11px] text-muted-foreground">
          not granted by importing
        </span>
      </div>
      <p className="text-muted-foreground text-sm">{why}</p>
      {tools.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tools.map((tool) => (
            <ToolChip key={tool.ref}>{tool.ref}</ToolChip>
          ))}
        </div>
      ) : null}
      {/*
       * Each tool's own reason, kept but folded away. It is the author's justification per ref and
       * it matters at the moment somebody decides to grant one — which happens on the grant screens,
       * not here. On this page it was five paragraphs between the reader and the next section.
       */}
      {tools.length > 0 ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
            <IconChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            Why each tool
          </summary>
          <ul className="mt-2 grid gap-1.5 border-border border-l pl-3">
            {tools.map((tool) => (
              <li className="text-xs" key={tool.ref}>
                <span className="font-mono">{tool.ref}</span>
                <span className="text-muted-foreground"> — {tool.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * One skill, summarised, with the instructions a keystroke away.
 *
 * WHY THE INSTRUCTIONS FOLD AND THE ROLE DESCRIPTION DOES NOT. The role description is one block
 * that every run carries, so it is the page's substance and stays open. Skill instructions are N
 * blocks of comparable length, invoked one at a time by somebody typing a slash — on a template with
 * three of them they were most of the page's height, and the reader who wanted the third had to
 * scroll past two.
 *
 * Folded is not hidden: the text is in the document, unabridged and unformatted, and one press away
 * with the slug and the summary already on screen to tell somebody whether they want it. Nothing is
 * truncated, which is the property the tests hold down.
 */
export function SkillCard({
  slug,
  title,
  summary,
  instructions,
  tools,
}: {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <IconSparkles aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title}</span>
        <span className="font-mono text-muted-foreground text-xs">/{slug}</span>
      </div>
      <p className="text-muted-foreground text-sm">{summary}</p>
      {tools.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tools.map((tool) => (
            <ToolChip key={tool}>{tool}</ToolChip>
          ))}
        </div>
      ) : null}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
          <IconChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          <IconCode aria-hidden className="size-3.5" />
          The instructions this skill carries
        </summary>
        <div className="mt-2">
          <Verbatim capped={false}>{instructions}</Verbatim>
        </div>
      </details>
    </div>
  );
}
