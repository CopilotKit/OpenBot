import { IconSettings, type TablerIcon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SettingsToolCallState } from "./registry";
import { ScreenLink, type SettingsScreenLink } from "./screen-link";

/**
 * The frame every settings card that reads draws in: an icon, a title and a line under it, then the
 * settings in sections as the screens list them, and the screen to open. The same card shape as the
 * change card (`settings-change-card.tsx`), so a read and the change after it look like one thing.
 *
 * Built for the chat column: each row is a name over its value at a phone's width and side by side
 * from a laptop's, so a long value wraps instead of squeezing.
 */
export function SettingsReadCard({
  title,
  caption,
  icon: Icon = IconSettings,
  state,
  reason,
  link,
  wrapTitle = false,
  children,
}: {
  title: string;
  /** A title that is a sentence (a job to do) wraps onto a second line instead of being cut. */
  wrapTitle?: boolean;
  /** One line under the title. */
  caption?: string;
  icon?: TablerIcon;
  state: SettingsToolCallState;
  /** Why it was refused or didn't work, in the person's words. */
  reason?: string;
  link?: SettingsScreenLink;
  children?: ReactNode;
}) {
  const body =
    state === "running" ? null : state === "done" ? (
      children
    ) : reason ? (
      <p className="text-sm" role={state === "failed" ? "alert" : "status"}>
        {reason}
      </p>
    ) : null;
  return (
    <figure
      aria-busy={state === "running"}
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
      data-settings-card
      data-state={state}
    >
      <figcaption
        className={cn(
          "flex items-start gap-3 px-4 py-3",
          (body || (link && state === "done")) && "border-border border-b",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            className={cn(
              "font-medium text-sm",
              wrapTitle ? "text-pretty break-words" : "truncate",
            )}
          >
            {title}
          </p>
          <p
            className={cn(
              "text-muted-foreground text-xs",
              state === "running" && "animate-pulse motion-reduce:animate-none",
            )}
          >
            {state === "running"
              ? "Reading…"
              : state === "done"
                ? caption
                : state === "refused"
                  ? "Not read"
                  : "Couldn't be read"}
          </p>
        </div>
      </figcaption>
      {body || (link && state === "done") ? (
        <div className="flex flex-col gap-4 px-4 py-3">
          {body}
          {link && state === "done" ? <ScreenLink {...link} /> : null}
        </div>
      ) : null}
    </figure>
  );
}

/** A section of settings under its name, as a settings screen titles it. */
export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-section={title}>
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <dl className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </dl>
    </section>
  );
}

/** One setting: its name and its value, side by side where there is room. */
export function SettingsRow({
  label,
  children,
  stacked = false,
}: {
  label: string;
  children: ReactNode;
  /** Always the name over the value: for free text, which reads better full width. */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 px-3 py-2.5 text-sm",
        !stacked && "sm:flex-row sm:items-baseline sm:justify-between sm:gap-4",
      )}
      data-setting={label}
    >
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 whitespace-pre-line break-words",
          !stacked && "sm:text-right",
        )}
        data-value
      >
        {children}
      </dd>
    </div>
  );
}

/** A value that isn't set, said as the screens say it. */
export function NotSet({ children = "Not set" }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
