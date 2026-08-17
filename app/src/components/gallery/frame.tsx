import type { ReactNode } from "react";

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
    <figure className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card">
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
