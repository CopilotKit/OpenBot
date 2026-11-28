import { IconChevronRight, IconCompass } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { SettingsToolCardProps } from "./registry";
import { SettingsReadCard } from "./settings-read-card";

/**
 * `where_do_i_change`: the screens where the person changes what a Bot can't change for them, each
 * one a link with what is on it.
 */

type Screen = { topic?: string; title?: string; path?: string; about?: string };

export function WhereDoIChangeCard({
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const screens = ((output?.screens as Screen[] | undefined) ?? []).filter(
    (screen): screen is Required<Screen> =>
      typeof screen.title === "string" &&
      typeof screen.path === "string" &&
      // Only OpenBot's own screens become links.
      screen.path.startsWith("/"),
  );
  return (
    <SettingsReadCard
      caption={
        screens.length === 1
          ? "Change it here yourself."
          : "Change these here yourself."
      }
      icon={IconCompass}
      state={state}
      title={
        screens.length === 1
          ? (screens[0]?.title ?? "Where to change it")
          : "Where to change it"
      }
      {...(reason ? { reason } : {})}
    >
      {screens.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
          {screens.map((screen) => (
            <li data-screen={screen.path} key={screen.path}>
              <Link
                className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
                to={screen.path as never}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium text-sm">{screen.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {screen.about}
                  </span>
                </span>
                <IconChevronRight
                  aria-hidden
                  className="size-4 shrink-0 self-center text-muted-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          There's no screen for that you can open.
        </p>
      )}
    </SettingsReadCard>
  );
}
