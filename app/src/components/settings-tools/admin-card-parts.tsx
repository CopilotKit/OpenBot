import { IconArrowRight, IconUsers } from "@tabler/icons-react";
import type { ComponentType, ReactNode } from "react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { PersonAvatar } from "@/components/organizations/person-avatar";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  AdminScreen,
  AdminToolResult,
  Affected,
  AffectedPerson,
  ChangeLine,
  ChangeView,
} from "./admin-tool-results";
import { ScreenLinks as SettingsScreenLinks } from "./screen-link";

/**
 * The pieces every admin settings card is drawn from, so a change a Bot made reads as the Admin
 * screen it came from: the same rows (`Item`, divided as `PageRows` divides them), the same 32px
 * icon tiles, the same avatars as the Members list, and the switch words the screens use.
 *
 * Stacked, never side by side: the chat column is narrow, so a before and after sit on one line
 * only as two short values with an arrow between them, and wrap under the label when they're long.
 */

/** Where a card's rows sit: the Admin screens' bordered group of divided rows, inside the card. */
export function CardRows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-background/40 dark:border-transparent dark:bg-muted/30",
        "[&_[data-slot=item]]:rounded-none [&_[data-slot=item]]:px-3 [&_[data-slot=item]]:py-2.5",
        "[&_[data-slot=separator][data-orientation=horizontal]]:mx-3 [&_[data-slot=separator][data-orientation=horizontal]]:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A small heading over a group of rows. */
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 font-medium text-muted-foreground text-xs">
      {children}
    </p>
  );
}

/** The words a switch on the Admin screens reads as, for a value that is one. */
const SWITCHED: Record<string, boolean> = { On: true, Off: false };

/**
 * One value, as the screen shows it: what it was, struck through, or what it is now. A switch's
 * value is drawn with the screen's own switch beside it, set as it was or as it is, never pressable.
 */
function Value({ text, was }: { text: string; was?: boolean }) {
  const switched = SWITCHED[text];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs",
        was
          ? "bg-foreground/5 text-muted-foreground"
          : "bg-primary/10 font-medium text-foreground dark:bg-primary/20",
      )}
    >
      {switched !== undefined ? (
        <Switch
          aria-hidden
          checked={switched}
          className={cn("pointer-events-none", was && "opacity-50")}
          readOnly
          size="sm"
          tabIndex={-1}
        />
      ) : null}
      <span
        className={cn(
          "break-words",
          was && "line-through decoration-foreground/30",
        )}
      >
        {text}
      </span>
    </span>
  );
}

/** A before and an after, as two values and an arrow. Added and removed say so. */
export function BeforeAfter({ line }: { line: ChangeLine }) {
  if (line.before === null && line.after !== null)
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="positive">New</Badge>
        <Value text={line.after} />
      </span>
    );
  if (line.after === null)
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {line.before !== null ? <Value text={line.before} was /> : null}
        <IconArrowRight
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <Badge tone="negative">Removed</Badge>
      </span>
    );
  // Two short values sit on one line; a long one stacks, the new value under the old.
  const long = (line.before?.length ?? 0) + line.after.length > 36;
  if (long)
    return (
      <span className="flex flex-col items-start gap-1">
        <Value text={line.before ?? ""} was />
        <span className="flex max-w-full items-center gap-1.5">
          <IconArrowRight
            aria-label="changes to"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Value text={line.after} />
        </span>
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Value text={line.before ?? ""} was />
      <IconArrowRight
        aria-label="changes to"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <Value text={line.after} />
    </span>
  );
}

/** Each change as a row: its name, then what it was and what it is. */
export function ChangeRows({
  changes,
  icon: Icon,
}: {
  changes: readonly ChangeLine[];
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <CardRows>
      {changes.map((line, index) => (
        <div key={`${line.label}\u0000${line.before}\u0000${line.after}`}>
          <Item size="sm">
            <ItemMedia variant="icon">
              <Icon />
            </ItemMedia>
            <ItemContent className="min-w-0 gap-1">
              <ItemTitle className="line-clamp-2 w-auto">
                {line.label}
              </ItemTitle>
              <div className="text-xs" data-testid="before-after">
                <BeforeAfter line={line} />
              </div>
            </ItemContent>
          </Item>
          {index !== changes.length - 1 ? <Separator /> : null}
        </div>
      ))}
    </CardRows>
  );
}

const EFFECT_WORDS: Record<
  NonNullable<AffectedPerson["effect"]>,
  { label: string; tone: Tone }
> = {
  gains: { label: "Gains access", tone: "positive" },
  loses: { label: "Loses access", tone: "negative" },
  changes: { label: "Changes", tone: "caution" },
  joins: { label: "Joins", tone: "positive" },
  leaves: { label: "Leaves", tone: "negative" },
};

/** People shown by name; the rest are counted in a last line. */
const SHOWN = 5;

/** Who the change reaches: a line saying it, then each person as the Members list draws them. */
export function AffectedRows({ affected }: { affected: Affected }) {
  const shown = affected.people.slice(0, SHOWN);
  const more = Math.max(0, affected.count - shown.length);
  return (
    <CardRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconUsers />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-2 w-auto">
            {affected.summary}
          </ItemTitle>
        </ItemContent>
      </Item>
      {shown.map((person) => (
        <div key={person.email}>
          <Separator />
          <Item size="sm">
            <ItemMedia>
              <PersonAvatar
                person={{ name: person.name, email: person.email, image: null }}
              />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-auto min-w-0">
                <span className="truncate">{person.name}</span>
              </ItemTitle>
              {person.name !== person.email ? (
                <ItemDescription className="line-clamp-1 break-all">
                  {person.email}
                </ItemDescription>
              ) : null}
            </ItemContent>
            {person.effect ? (
              <ItemActions>
                <Badge tone={EFFECT_WORDS[person.effect].tone}>
                  {EFFECT_WORDS[person.effect].label}
                </Badge>
              </ItemActions>
            ) : null}
          </Item>
        </div>
      ))}
      {more > 0 ? (
        <>
          <Separator />
          <p className="px-3 py-2.5 text-muted-foreground text-xs">
            And {more} more {more === 1 ? "person" : "people"}.
          </p>
        </>
      ) : null}
    </CardRows>
  );
}

/** Links to the Admin screens the change shows on. */
export function ScreenLinks({ screens }: { screens: readonly AdminScreen[] }) {
  return (
    <SettingsScreenLinks
      links={screens.map((screen) => ({
        to: screen.path,
        label: `Open ${screen.label}`,
      }))}
    />
  );
}

/** What the change does and who it reaches: the body of the approval card and of the result card. */
export function AdminChangeDetails({
  result,
  icon,
  made = true,
  headline = false,
}: {
  result: ChangeView;
  icon: ComponentType<{ className?: string }>;
  /** False for a change that wasn't made: the labels say what it would have done. */
  made?: boolean;
  /** Say the change in a sentence first, for the approval card, whose title names only the tool. */
  headline?: boolean;
}) {
  return (
    <div className="space-y-3">
      {headline ? (
        <p className="font-medium text-sm">{result.summary}</p>
      ) : null}
      {result.changes.length > 0 ? (
        <div>
          <CardLabel>
            {made ? "What changes" : "What it would change"}
          </CardLabel>
          <ChangeRows changes={result.changes} icon={icon} />
        </div>
      ) : null}
      {result.affected.summary ? (
        <div>
          <CardLabel>
            {made ? "Who it reaches" : "Who it would reach"}
          </CardLabel>
          <AffectedRows affected={result.affected} />
        </div>
      ) : null}
    </div>
  );
}

/** Where a change is, as the settings card registry says it: being saved, saved, or not. */
export type AdminCardState = "running" | "done" | "refused" | "failed";

const STATE_BADGES: Record<AdminCardState, { label: string; tone: Tone }> = {
  // The words every settings card uses (settings-change-card.tsx).
  running: { label: "Changing", tone: "neutral" },
  done: { label: "Changed", tone: "positive" },
  refused: { label: "Not changed", tone: "negative" },
  failed: { label: "Didn't work", tone: "negative" },
};

/**
 * The card a change leaves in the conversation once it's done, or once it wasn't: the frame every
 * Bot card uses, a 32px tile with the tool's mark, the change in a sentence, and its state.
 */
export function AdminChangeCard({
  title,
  caption,
  icon: Icon,
  rowIcon,
  state,
  message,
  result,
  footer,
}: {
  title: string;
  caption: string;
  icon: ComponentType<{ className?: string }>;
  /** The mark on each changed row, as the screen draws that row. The card's own mark otherwise. */
  rowIcon?: ComponentType<{ className?: string }>;
  state: AdminCardState;
  /** Said under the header when the change wasn't made: the refusal, or that the person said no. */
  message?: string;
  result?: AdminToolResult;
  footer?: ReactNode;
}) {
  const badge = STATE_BADGES[state];
  return (
    <figure
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
      data-slot="admin-change-card"
      data-state={state}
    >
      <figcaption className="flex items-start gap-3 border-border border-b px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm leading-snug">{title}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{caption}</p>
        </div>
        <span className="flex h-5 shrink-0 items-center">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
      </figcaption>
      <div
        className={cn(
          "space-y-3 px-4 py-3",
          !message && !result && !footer && "hidden",
        )}
      >
        {message ? (
          <p
            className={cn(
              "text-sm",
              state === "refused" || state === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
            role={
              state === "refused" || state === "failed" ? "alert" : undefined
            }
          >
            {message}
          </p>
        ) : null}
        {result ? (
          <AdminChangeDetails
            icon={rowIcon ?? Icon}
            made={state === "done"}
            result={result}
          />
        ) : null}
        {footer}
        {result && state === "done" ? (
          <ScreenLinks screens={result.screens} />
        ) : null}
      </div>
    </figure>
  );
}
