import { IconMessageCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useNeedsYouCount } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { IconTasksList } from "./icons";
import { FOCUS } from "./kit";
import { type OpenDuetTab, TASKS_LINK } from "./places";

const TAB =
  "relative flex flex-1 flex-col items-center justify-center gap-px rounded-[27px] transition-colors motion-reduce:transition-none";

/**
 * The frosted pill at the foot of the app: Chat and Tasks, the current one on a grey capsule.
 * Tasks carries how many tasks need the person, counted the way OpenBot's Tasks lists them under
 * Needs you, so the badge and the list never disagree.
 */
export function TabBar({ current }: { current: OpenDuetTab }) {
  const waiting = useNeedsYouCount();
  const tabs = [
    { id: "chat" as const, label: "Chat", Glyph: IconMessageCircle, badge: 0 },
    {
      id: "tasks" as const,
      label: "Tasks",
      Glyph: IconTasksList,
      badge: waiting,
    },
  ];
  return (
    <nav
      aria-label="Main"
      className="openduet-glass absolute inset-x-0 bottom-[22px] z-20 mx-auto flex h-16 w-[236px] max-w-[calc(100%-32px)] gap-0.5 rounded-[32px] p-[5px] shadow-openduet-glass"
    >
      {tabs.map(({ id, label, Glyph, badge }) => {
        const on = id === current;
        const body = (
          <>
            <Glyph size={20} stroke={on ? 2.1 : 1.9} />
            <span
              className={cn(
                "openduet-type-caption",
                on ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </span>
            {badge ? (
              <span
                aria-hidden
                className={cn(
                  "openduet-type-caption absolute top-1 left-1/2 ml-[7px] grid h-5 min-w-5 place-items-center rounded-full bg-openduet-accent px-1 font-semibold text-openduet-on-accent tabular-nums",
                  on
                    ? "shadow-[0_0_0_2px_var(--openduet-tile)]"
                    : "shadow-[0_0_0_2px_var(--openduet-card)]",
                )}
              >
                {badge}
              </span>
            ) : null}
          </>
        );
        const className = cn(
          TAB,
          FOCUS,
          on
            ? "bg-openduet-tile text-openduet-ink"
            : "text-openduet-ink-2 hover:text-openduet-ink",
        );
        const name = badge
          ? `${label}, ${badge} ${badge === 1 ? "needs" : "need"} you`
          : label;
        return id === "chat" ? (
          <Link
            activeOptions={{ exact: true }}
            aria-current={on ? "page" : undefined}
            aria-label={name}
            className={className}
            key={id}
            to="/"
          >
            {body}
          </Link>
        ) : (
          <Link
            {...TASKS_LINK}
            aria-current={on ? "page" : undefined}
            aria-label={name}
            className={className}
            key={id}
          >
            {body}
          </Link>
        );
      })}
    </nav>
  );
}
