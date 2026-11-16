import { IconDots } from "@tabler/icons-react";
import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * An action a row can put in its menu when its line has no room: the button drawn on the row, and
 * the same action as an item in the row's "More actions" menu.
 */
export type SecondaryAction = {
  key: string;
  button: ReactNode;
  menuItem: ReactNode;
};

/**
 * One row of the Needs you board, whatever it holds: a question, an action to allow, a task, or
 * something a check-in found. One shape for all of them, so the board reads as one list.
 *
 * An icon in a small square (tinted where a Bot is stopped on the person), the title and one line
 * of detail, a quiet line of where and when, and the row's actions on the right. `more` is what
 * opens under the row; `onSelect` opens something else instead (a question's answer dialog).
 *
 * WHERE THE ROW IS NARROW (a phone, a chat's width, a window with the sidebar beside it) it stacks:
 * the title in full and the status line across the row, and the actions on a line of their own
 * under them. FOUND LIVE at 390px: with the actions kept beside the words, a task waiting on a
 * question had a title of "P.." and its status ran down the row a word to a line. Where the row is
 * wide, the actions sit on the right and the title and detail are cut to a line until it is opened.
 * Whether it is narrow is the row's own width (a container query), not the window's.
 *
 * `secondary` are the actions that matter least (Mark done, Open beside a task's answers). They are
 * buttons on the row while its line has room for them, and move into a "More actions" menu when it
 * does not, measured on the row as drawn.
 */
export function BoardRow({
  icon,
  state,
  waiting = false,
  title,
  detail,
  meta = [],
  actions,
  secondary = [],
  more,
  open: openFromParent,
  wholeDetail = false,
  readDetail = false,
  onSelect,
}: {
  icon: ReactNode;
  /** Where a task's row stands, for finding it: "failed", "stopped", "working". */
  state?: string;
  /** A Bot is stopped on this: the icon's square is tinted. */
  waiting?: boolean;
  title: ReactNode;
  detail?: string | null;
  /** Small pieces of where and when, joined with a dot. */
  meta?: ReactNode[];
  /**
   * The row's answers. Given as a function, it is handed the folded secondary actions' menu items
   * (null while they are buttons) to put in a menu of its own, so the row never has two menus.
   */
  actions?: ReactNode | ((folded: ReactNode | null) => ReactNode);
  /** Drawn after `actions`, and folded into a menu when the line has no room for them. */
  secondary?: SecondaryAction[];
  /** Drawn under the row while it is open. */
  more?: ReactNode;
  /** Opened by the parent (an Answer button), as well as by a click on the text. */
  open?: boolean;
  /**
   * The detail is never cut: what an approval would act on is read whole before Allow, however
   * long, and broken anywhere rather than run off the row.
   */
  wholeDetail?: boolean;
  /**
   * The detail is what the person is asked for ("Waiting for your approval: …"), so it is read in
   * full, wrapped at word breaks, at every width. Cut to one line it read "hand this to Pipeline…".
   */
  readDetail?: boolean;
  /** A click on the text does this instead of opening the row in place. */
  onSelect?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const open = opened || openFromParent === true;
  const opens = Boolean(onSelect || (detail && !wholeDetail) || more || title);
  const shownMeta = meta.filter(Boolean);
  const { content, actionLine, folded } = useFolding(secondary.length > 0);
  const hasActions = Boolean(actions) || secondary.length > 0;
  const menuItems = secondary.map((action) => (
    <Fragment key={action.key}>{action.menuItem}</Fragment>
  ));
  return (
    <div
      className="@container/board-row flex flex-col gap-2 px-3.5 py-3"
      data-slot="item"
      data-task-state={state}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-[13px] [&_svg]:size-4",
            waiting &&
              "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1" data-slot="item-content" ref={content}>
          {opens ? (
            <button
              aria-expanded={open}
              className="block w-full min-w-0 cursor-pointer text-left"
              onClick={() => (onSelect ? onSelect() : setOpened(!opened))}
              type="button"
            >
              <RowText
                detail={detail}
                open={open || wholeDetail || readDetail}
                title={title}
                whole={wholeDetail}
              />
            </button>
          ) : (
            <RowText
              detail={detail}
              open={open || wholeDetail || readDetail}
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
        {hasActions ? (
          <div
            className={cn(
              // Narrow: a line of its own, under the words (past the icon). Wide: on the right.
              "flex min-w-0 basis-full items-center gap-1.5 pl-10 @[40rem]/board-row:shrink-0 @[40rem]/board-row:basis-auto @[40rem]/board-row:pl-0",
              // Folded and still too long, it wraps: nothing is ever cut off.
              folded ? "flex-wrap" : "flex-nowrap",
            )}
            data-slot="item-actions"
            ref={actionLine}
          >
            {typeof actions === "function"
              ? actions(folded ? menuItems : null)
              : actions}
            {folded ? (
              typeof actions === "function" ? null : (
                <RowMenu
                  label={
                    typeof title === "string"
                      ? `More actions for ${title}`
                      : "More actions"
                  }
                >
                  {menuItems}
                </RowMenu>
              )
            ) : (
              secondary.map((action) => (
                <Fragment key={action.key}>{action.button}</Fragment>
              ))
            )}
          </div>
        ) : null}
      </div>
      {open && more ? <div className="pl-10">{more}</div> : null}
    </div>
  );
}

/**
 * A row's menu is as wide as its longest item, on one line, and never wider than the window has room
 * for. Left at the trigger's width it was 128px, and "Allow for this conversation" broke in two.
 */
export const ROW_MENU_WIDTH = "w-max max-w-(--available-width)";

/** A row's menu, behind a "…" button named for what it holds. */
export function RowMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button aria-label={label} size="icon-sm" variant="ghost" />}
      >
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={ROW_MENU_WIDTH}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Whether a row's secondary actions are folded into its menu: when the row is stacked (its actions on
 * a line of their own under its words) and that line is narrower than the actions drawn whole. The
 * width they need whole is remembered from when they were last drawn, so they come back as soon as
 * the line is wide enough again, and a wide row, its actions on the right, never folds.
 *
 * Measured on the row as the browser lays it out. Where nothing is laid out (no ResizeObserver, or
 * every width zero), nothing folds.
 */
function useFolding(enabled: boolean) {
  const content = useRef<HTMLDivElement>(null);
  const actionLine = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  const foldedNow = useRef(false);
  const wholeWidth = useRef(0);
  useLayoutEffect(() => {
    const words = content.current;
    const line = actionLine.current;
    if (!enabled || !words || !line || typeof ResizeObserver === "undefined")
      return;
    const fold = (next: boolean) => {
      foldedNow.current = next;
      setFolded(next);
    };
    const check = () => {
      const stacked =
        line.getBoundingClientRect().top >=
        words.getBoundingClientRect().bottom - 1;
      if (!stacked) {
        if (foldedNow.current) fold(false);
        return;
      }
      if (!foldedNow.current) {
        if (line.scrollWidth > line.clientWidth + 1) {
          wholeWidth.current = line.scrollWidth;
          fold(true);
        }
      } else if (line.clientWidth >= wholeWidth.current) fold(false);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(line);
    observer.observe(words);
    return () => observer.disconnect();
  }, [enabled]);
  return { content, actionLine, folded };
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
          // Read in full where the row is narrow; cut to a line beside its actions where it is wide.
          open
            ? "line-clamp-none"
            : "line-clamp-none @[40rem]/board-row:line-clamp-1",
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
