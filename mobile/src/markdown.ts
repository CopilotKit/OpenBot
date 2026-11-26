/**
 * A Bot's reply is Markdown, as the web app draws it (streamdown). This reads the part of Markdown a
 * Bot writes in a conversation into blocks and spans the phone can draw with its own text: headings,
 * paragraphs, lists, quotes, code, rules, and inside a line bold, italic, struck, code and links.
 * Anything it doesn't know stays as the text it was, so nothing a Bot wrote is ever lost.
 */

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Span[] }
  | { kind: "italic"; children: Span[] }
  | { kind: "strike"; children: Span[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Span[] };

export type ListItem = { spans: Span[]; checked?: boolean };

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "rule" };

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)/;
// A closing run of `#` counts only after a space, so "## Using C#" keeps its "#".
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** The blocks of a Bot's reply, in order. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    const marker = fence?.[2] ?? "```";
    // "```code```" on one line is inline code in a paragraph, not the start of a block.
    if (fence && !line.trim().slice(marker.length).includes(marker)) {
      // A fence set in under a list item: its lines lose that indent.
      const indent = fence[1]?.length ?? 0;
      const body: string[] = [];
      index++;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith(marker)
      ) {
        const current = lines[index] ?? "";
        body.push(
          current.slice(0, indent).trim() ? current : current.slice(indent),
        );
        index++;
      }
      index++; // the closing fence, or the end of the reply
      blocks.push({
        kind: "code",
        language: fence[3] || undefined,
        text: body.join("\n"),
      });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        spans: parseInline(heading[2] ?? ""),
      });
      index++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        body.push(QUOTE.exec(lines[index] ?? "")?.[1] ?? "");
        index++;
      }
      blocks.push({ kind: "quote", blocks: parseMarkdown(body.join("\n")) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (match) {
          const text = (ordered ? match[3] : match[2]) ?? "";
          const task = TASK.exec(text);
          items.push(
            task
              ? {
                  spans: parseInline(task[2] ?? ""),
                  checked: task[1] !== " ",
                }
              : { spans: parseInline(text) },
          );
          index++;
          continue;
        }
        // A code block under an item ends the list here and is drawn as code; the list may carry on after it.
        if (FENCE.test(current)) break;
        // A line set in under an item carries on that item; a blank line or anything else ends the list.
        const last = items[items.length - 1];
        if (last && /^\s{2,}\S/.test(current)) {
          last.spans = [
            ...last.spans,
            { kind: "text", text: " " },
            ...parseInline(current.trim()),
          ];
          index++;
          continue;
        }
        break;
      }
      blocks.push({
        kind: "list",
        ordered,
        start: ordered ? Number(numbered?.[2] ?? 1) : 1,
        items,
      });
      continue;
    }
    // A paragraph: lines up to a blank line or the start of another block, joined as one.
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        !current.trim() ||
        // Every check but the blank line is for a line after the first: the first is always taken, so this ends.
        (body.length > 0 && FENCE.test(current)) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current) ||
        (body.length > 0 && RULE.test(current))
      )
        break;
      body.push(current.trim());
      index++;
    }
    // Never stand still: a line no rule above took is still read, as a paragraph of its own.
    if (body.length === 0) {
      body.push(line.trim());
      index++;
    }
    blocks.push({ kind: "paragraph", spans: parseInline(body.join("\n")) });
  }
  return blocks;
}

/** What a line says, in spans. */
export function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let plain = "";
  const flush = () => {
    if (plain) spans.push({ kind: "text", text: plain });
    plain = "";
  };
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index];
    // A backslash keeps the next mark as text.
    if (char === "\\" && /^\\[\\`*_~[\]()#>!-]/.test(rest)) {
      plain += rest[1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`";
      const end = rest.indexOf(ticks, ticks.length);
      if (end > 0) {
        flush();
        spans.push({
          kind: "code",
          text: rest.slice(ticks.length, end).trim(),
        });
        index += end + ticks.length;
        continue;
      }
    }
    if (char === "[") {
      const link =
        /^\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(
          rest,
        );
      if (link && isSafeLink(link[2] ?? "")) {
        flush();
        spans.push({
          kind: "link",
          href: link[2] ?? "",
          children: parseInline(link[1] ?? ""),
        });
        index += link[0].length;
        continue;
      }
    }
    if (char === "h" && /^https?:\/\//.test(rest) && !/\w$/.test(plain)) {
      const url = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/.exec(rest)?.[0];
      if (url) {
        flush();
        spans.push({
          kind: "link",
          href: url,
          children: [{ kind: "text", text: url }],
        });
        index += url.length;
        continue;
      }
    }
    const emphasis = readEmphasis(source, index, plain);
    if (emphasis) {
      flush();
      spans.push(emphasis.span);
      index = emphasis.end;
      continue;
    }
    plain += char;
    index++;
  }
  flush();
  return spans;
}

/** Bold (`**`, `__`), italic (`*`, `_`) or struck (`~~`) text starting at `index`, if it closes. */
function readEmphasis(
  source: string,
  index: number,
  before: string,
): { span: Span; end: number } | null {
  // Bold and italic at once: bold around italic.
  if (source.startsWith("***", index) && !/\s/.test(source[index + 3] ?? "")) {
    const close = source.indexOf("***", index + 3);
    if (close > index + 3 && !/\s/.test(source[close - 1] ?? ""))
      return {
        span: {
          kind: "bold",
          children: [
            {
              kind: "italic",
              children: parseInline(source.slice(index + 3, close)),
            },
          ],
        },
        end: close + 3,
      };
  }
  for (const [marker, kind] of [
    ["**", "bold"],
    ["__", "bold"],
    ["~~", "strike"],
    ["*", "italic"],
    ["_", "italic"],
  ] as const) {
    if (!source.startsWith(marker, index)) continue;
    const open = index + marker.length;
    // An opening mark is followed by text, not a space; `_` inside a word (snake_case) is not a mark.
    if (!source[open] || /\s/.test(source[open] ?? "")) continue;
    if (marker.startsWith("_") && /\w$/.test(before)) continue;
    let close = source.indexOf(marker, open);
    while (close > open) {
      const after = source[close + marker.length] ?? "";
      const inner = source[close - 1] ?? "";
      const single = marker.length === 1;
      if (
        !/\s/.test(inner) &&
        // A single `*` that is half of a `**` belongs to the bold.
        !(single && source[close + 1] === marker) &&
        !(marker.startsWith("_") && /\w/.test(after))
      )
        break;
      close = source.indexOf(marker, close + 1);
    }
    if (close <= open) continue;
    const children = parseInline(source.slice(open, close));
    return {
      span: { kind, children } as Span,
      end: close + marker.length,
    };
  }
  return null;
}

/** Only web and mail links open from a reply: never a script, a file, or another app's scheme. */
export function isSafeLink(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/** The words of spans, with every mark taken away: what a screen reader and a preview read. */
export function plainText(spans: Span[]): string {
  return spans
    .map((span) =>
      span.kind === "text" || span.kind === "code"
        ? span.text
        : plainText(span.children),
    )
    .join("");
}
