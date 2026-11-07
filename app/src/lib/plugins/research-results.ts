import {
  type ResearchRole,
  researchRoleOfTool,
} from "@openbot/shared/research";
import { asText, withoutUntrustedEnvelope } from "./tool-result";

/** The research role of a call by its full `mcp__server__tool` name, or null when it plays none. */
export function researchRoleOfCall(name: string): ResearchRole | null {
  const [prefix, server, ...tool] = name.split("__");
  if (prefix !== "mcp" || !server || !tool.length) return null;
  return researchRoleOfTool(server, tool.join("__"));
}

/** What a list of research results is, for a screen reader. */
export const RESEARCH_RESULTS_LABELS: Readonly<Record<ResearchRole, string>> =
  Object.freeze({ search: "Search results", fetch: "Pages read" });

/** One page a research call found or read, as a person would want to see it. */
export type ResearchSource = {
  url: string;
  /** The page's host without `www.`: "imf.org". */
  site: string;
  title?: string;
  /** A few readable lines from the page, markdown taken out and real line breaks kept. */
  excerpt?: string;
  /** As the provider gave it: "2025-04-01" or a full ISO timestamp. */
  published?: string;
};

/** Longer than this and the card would be the page itself; the link is there for the rest. */
const MAX_EXCERPT = 1200;

/**
 * The sources in a research call's answer, or null when it holds none this can read.
 *
 * Every research provider answers in its own shape, and none of them is meant for a person: Parallel
 * sends `{ search_id, results: [{ url, title, excerpts }] }`, Firecrawl `{ web: [{ url, title,
 * description }] }` or a scraped page with its `metadata`, and Exa a block of `Title:` and `URL:`
 * lines per result. Each is read into the same list, so a search or a page read is drawn as the
 * pages it found, whichever provider answered. Null sends the answer back to the generic output,
 * which still shows everything: an error, an empty result, a shape no provider has sent yet.
 */
export function readResearchSources(result: string): ResearchSource[] | null {
  const text = withoutUntrustedEnvelope(asText(result)).trim();
  const found =
    text.startsWith("{") || text.startsWith("[")
      ? fromJson(text)
      : fromExaText(text);
  // A page found twice is one page, the first time it was found.
  const seen = new Set<string>();
  const sources = found.filter(
    (source) => !seen.has(source.url) && !!seen.add(source.url),
  );
  return sources.length ? sources : null;
}

function fromJson(text: string): ResearchSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return entriesOf(parsed).flatMap((entry) => {
    const source = fromEntry(entry);
    return source ? [source] : [];
  });
}

/** The list of results inside a provider's envelope, or the one page a scrape returned. */
function entriesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = recordOf(value);
  if (!object) return [];
  const lists = ["results", "web", "news", "data"]
    .map((key) => object[key])
    .filter(Array.isArray)
    .flat();
  if (lists.length) return lists;
  // Firecrawl's `{ success, data: { web: [...] } }` and `{ data: { markdown, metadata } }`.
  if (recordOf(object.data)) return entriesOf(object.data);
  return [object];
}

function fromEntry(value: unknown): ResearchSource | null {
  const entry = recordOf(value);
  if (!entry) return null;
  const metadata = recordOf(entry.metadata) ?? {};
  const url = text(
    entry.url,
    entry.link,
    metadata.sourceURL,
    metadata.url,
    metadata.ogUrl,
  );
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const title = text(entry.title, metadata.title, metadata.ogTitle);
  const excerpt = text(
    lines(entry.excerpts),
    lines(entry.highlights),
    entry.description,
    entry.snippet,
    entry.summary,
    entry.text,
    entry.markdown,
    entry.full_content,
    entry.content,
    metadata.description,
  );
  const published = text(
    entry.publish_date,
    entry.publishedDate,
    entry.date,
    metadata.publishedTime,
  );
  return source(url, title, excerpt, published);
}

/** Exa's `Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n…` blocks, split on `---`. */
function fromExaText(text: string): ResearchSource[] {
  return text.split(/\n\s*---\s*\n/).flatMap((block) => {
    const field = (name: string) =>
      block.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
    const url = field("URL");
    if (!url || !/^https?:\/\//i.test(url)) return [];
    const known = (value: string | undefined) =>
      value && value !== "N/A" ? value : undefined;
    const body = block.match(/^(?:Highlights|Text|Summary):[ \t]*([\s\S]*)$/m);
    const made = source(
      url,
      known(field("Title")),
      body?.[1],
      known(field("Published")),
    );
    return made ? [made] : [];
  });
}

function source(
  url: string,
  title: string | undefined,
  excerpt: string | undefined,
  published: string | undefined,
): ResearchSource | null {
  let site: string;
  try {
    site = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  const readable = excerpt ? plainExcerpt(excerpt) : "";
  return {
    url,
    site,
    ...(title ? { title: plainExcerpt(title).replace(/\s+/g, " ") } : {}),
    ...(readable ? { excerpt: readable } : {}),
    ...(published ? { published } : {}),
  };
}

/**
 * Markdown as the words it shows, with its line breaks kept.
 *
 * An excerpt is a cut of the page's markdown, often its navigation: `[Welcome](/)`, `![logo](…)`,
 * `## Heading`. Drawn as markdown, a cut-off list or table breaks the layout of the step around it;
 * drawn as the words, it reads as a quote from the page.
 */
export function plainExcerpt(markdown: string): string {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > MAX_EXCERPT
    ? `${plain.slice(0, MAX_EXCERPT - 1).trimEnd()}…`
    : plain;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lines(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter(
    (part): part is string => typeof part === "string" && !!part.trim(),
  );
  return parts.length ? parts.join("\n\n") : undefined;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values)
    if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}
