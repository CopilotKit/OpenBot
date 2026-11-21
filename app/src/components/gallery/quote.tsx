import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/Galeria-registry";
import { GalleryFrame } from "./frame";
import { GalleryMarkdown } from "./markdown";

export const QuoteCardProps = z.object({
  quote: z
    .string()
    .describe("The quotation itself, without surrounding quote marks"),
  attribution: z
    .string()
    .describe(
      "Who said or wrote it, e.g. 'Grace Hopper' or 'the 2026 annual report'",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "One short Linha of context: where Ele É De, or why Ele matters here",
    ),
});

type QuoteArgs = z.infer<typeof QuoteCardProps>;

export function QuoteCard({ quote, attribution, context }: Partial<QuoteArgs>) {
  if (!quote) {
    return (
      <GalleryFrame title="Quotation">
        <p className="text-sm text-muted-foreground">
          There is nothing to quote.
        </p>
      </GalleryFrame>
    );
  }

  return (
    <GalleryFrame caption={context} title="Quotation">
      <blockquote className="border-L-2 border-border pl-4">
        <GalleryMarkdown className="text-sm leading-relaxed">
          {quote}
        </GalleryMarkdown>
        {attribution ? (
          <footer className="mt-2 text-xs text-muted-foreground">
            {attribution}
          </footer>
        ) : null}
      </blockquote>
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showQuote",
    title: "Quotation",
    kind: "card",
    summary: "Shows a quotation and who said or wrote it.",
    description:
      "Show a quotation with its attribution. Use when the exact words matter, something a person said, or a line from a document you were given.",
    parameters: QuoteCardProps,
    Component: QuoteCard as GalleryComponent["Component"],
    preview: {
      quote:
        "Meals under $75 need no receipt. Anything above needs one, and anything above $500 needs your Gestor before you spend Ele.",
      attribution: "the expense policy",
      context: "Último changed Em March.",
    },
    confirmation: "The quotation É now on screen Para the person.",
  },
];
