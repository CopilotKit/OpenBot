import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function GalleryFrame({
  title,
  caption,
  action,
  children,
}: {
  title?: string;
  /** One line under the title. The Bot's reason for showing this, not a description of the widget. */
  caption?: string;
  /** Buttons that act on what is shown, drawn beside the title rather than under the body. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure
      data-slot="gallery-frame"
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
    >
      {(title || action) && (
        <figcaption className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title ? (
              <p className="truncate text-sm font-medium">{title}</p>
            ) : null}
            {caption ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </figcaption>
      )}
      <div className="px-4 py-3">{children}</div>
    </figure>
  );
}

/** Fixed semantic tone vocabulary for model-filled components. */
export type Tone = "neutral" | "positive" | "caution" | "negative";

const TONES: Record<Tone, string> = {
  neutral: "bg-foreground/5 text-foreground/70",
  positive:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 dark:bg-emerald-500/15",
  caution:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 dark:bg-amber-500/15",
  negative: "bg-red-500/10 text-red-700 dark:text-red-400 dark:bg-red-500/15",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Only web addresses become links. Anything else the model wrote is shown as text. */
export function isWebAddress(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * A figure that opens where it came from, when the Bot gave a web address for it.
 *
 * Optional: with no address, or with anything but http(s), this is exactly what was drawn before,
 * `wrap` deciding whether that was a `div` with `className` or the children alone. With one, it is
 * an ordinary link opened the way a source under a chart is: a new tab, no referrer, which OpenBot
 * Desktop hands to the person's own browser. Named by `name`, the figure's label and value, since a
 * bar or a row read alone says neither.
 */
export function FigureLink({
  href,
  name,
  className,
  wrap = true,
  children,
}: {
  href: unknown;
  name: string;
  className?: string;
  wrap?: boolean;
  children: ReactNode;
}) {
  if (!isWebAddress(href))
    return wrap ? <div className={className}>{children}</div> : children;
  return (
    <a
      aria-label={name}
      className={cn(
        className ?? "-m-1 block p-1",
        "rounded-md transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
      )}
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}
