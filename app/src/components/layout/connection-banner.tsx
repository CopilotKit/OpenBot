import { IconCloudOff } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { askWhetherOpenBotAnswers } from "@/lib/deployment/queries";
import { desktopConnectionQueryOptions } from "@/lib/desktop/queries";
import {
  openbotUnreachable,
  subscribeReachability,
} from "@/lib/desktop/reachability";

/** The first check after the line appears, then twice as long each time, up to a minute. */
const FIRST_CHECK_MS = 5_000;
const LONGEST_CHECK_MS = 60_000;

/**
 * One line saying the OpenBot this window is connected to can't be reached, on every screen, until
 * it answers again.
 *
 * Only inside OpenBot Desktop connected to an OpenBot that runs somewhere else. There the page talks
 * to the desktop app on this computer, which says when that OpenBot did not answer
 * (`lib/desktop/reachability.ts`); without this line the person sees only each section's own failure
 * and nothing naming the cause. A browser has its own cues for a site that is down, and a local
 * Desktop has its own status, so neither draws it.
 *
 * It clears on the next request that gets an answer. While it shows it asks OpenBot itself now and
 * then, backing off, so it also clears on a screen that has nothing more to ask.
 *
 * The same bar as the update banner, so it reads as OpenBot's own.
 */
export function ConnectionBanner() {
  const connection = useQuery(desktopConnectionQueryOptions());
  const unreachable = useSyncExternalStore(
    subscribeReachability,
    openbotUnreachable,
    () => false,
  );
  const address =
    connection.data?.mode === "connected" ? connection.data.address : null;
  const showing = address !== null && unreachable;

  useEffect(() => {
    if (!showing) return;
    let wait = FIRST_CHECK_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      timer = setTimeout(async () => {
        await askWhetherOpenBotAnswers();
        if (stopped) return;
        wait = Math.min(wait * 2, LONGEST_CHECK_MS);
        check();
      }, wait);
    };
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [showing]);

  if (!showing) return null;
  const said = `Can't reach ${hostOf(address)}. OpenBot will reconnect when it answers.`;
  return (
    <aside
      aria-label="Connection"
      className="flex shrink-0 flex-col border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <div className="flex h-7 min-w-0 items-center gap-x-2">
        <IconCloudOff
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <p
          className="min-w-0 truncate text-foreground"
          role="status"
          title={said}
        >
          {said}
        </p>
      </div>
    </aside>
  );
}

/** "openbot.example.com", with its port when it has one. */
function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}
