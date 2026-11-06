import { Fragment, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * One row of the Needs you board, whatever it holds: a question, an action to allow, a task, or
 * something a check-in found. One shape for all of them, so the board reads as one list.
 *
 * An icon in a small square (tinted where a Bot is stopped on the person), the title and one line
 * of detail, each cut to a line until the row is opened with a click, a quiet line of where and
 * when, and the row's actions on the right. `more` is what opens under the row; `onSelect` opens
 * something else instead (a question's answer dialog).
 */
export function BoardRow({
  icon,
  waiting = false,
  title,
  detail,
  meta = [],
  actions,
  more,
  open: openFromParent,
  wholeDetail = false,
  onSelect,
}: {
  icon: ReactNode;
  /** A Bot is stopped on this: the icon's square is tinted. */
  waiting?: boolean;
  title: ReactNode;
  detail?: string | null;
  /** Small pieces of where and when, joined with a dot. */
  meta?: ReactNode[];
  actions?: ReactNode;
  /** Drawn under the row while it is open. */
  more?: ReactNode;
  /** Opened by the parent (an Answer button), as well as by a click on the text. */
  open?: boolean;
  /**
   * The detail is never cut: what an approval would act on is read whole before Allow, however
   * long, and broken anywhere rather than run off the row.
   */
  wholeDetail?: boolean;
  /** A click on the text does this instead of opening the row in place. */
  onSelect?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const open = opened || openFromParent === true;
  const opens = Boolean(onSelect || (detail && !wholeDetail) || more || title);
  const shownMeta = meta.filter(Boolean);
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3" data-slot="item">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-[13px] [&_svg]:size-4",
            waiting &&
              "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          {opens ? (
            <button
              aria-expanded={open}
              className="block w-full min-w-0 cursor-pointer text-left"
              onClick={() => (onSelect ? onSelect() : setOpened(!opened))}
              type="button"
            >
              <RowText
                detail={detail}
                open={open || wholeDetail}
                title={title}
                whole={wholeDetail}
              />
            </button>
          ) : (
            <RowText
              detail={detail}
              open={open || wholeDetail}
              title={title}
              whole={wholeDetail}
            />
          )}
          {shownMeta.length ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
              {shownMeta.map((piece, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are fixed per row.
                <Fragment key={index}>
                  {index > 0 ? <span aria-hidden>·</span> : null}
                  {piece}
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {open && more ? <div className="pl-10">{more}</div> : null}
    </div>
  );
}

function RowText({
  title,
  detail,
  open,
  whole,
}: {
  title: ReactNode;
  detail?: string | null;
  open: boolean;
  whole: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          "block font-medium text-sm leading-snug",
          open ? "line-clamp-none" : "line-clamp-1",
        )}
        data-slot="item-title"
      >
        {title}
      </span>
      {detail ? (
        <span
          className={cn(
            "mt-0.5 block text-[13px] text-muted-foreground",
            whole
              ? "line-clamp-none break-all"
              : open
                ? "line-clamp-none whitespace-pre-wrap"
                : "line-clamp-1",
          )}
        >
          {detail}
        </span>
      ) : null}
    </>
  );
}

/** A tag in a row's meta line: the app it was read with. */
export function MetaTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-1.5 py-px text-[11px]">
      {children}
    </span>
  );
}
