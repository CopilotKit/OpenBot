import { IconCloudOff } from "@tabler/icons-react";
import { useEffect } from "react";
import { askWhetherOpenBotAnswers } from "@/lib/deployment/queries";
import { useConnectionLost } from "@/lib/desktop/connection-lost";

/** The first check after the line appears, then twice as long each time, up to a minute. */
const FIRST_CHECK_MS = 5_000;
const LONGEST_CHECK_MS = 60_000;

/**
 * One line saying the OpenBot this window is connected to can't be reached, on every screen, until
 * it answers again.
 *
 * Only inside OpenBot Desktop connected to an OpenBot that runs somewhere else. There the page talks
 * to the desktop app on this computer, which says when that OpenBot did not answer
 * (`lib/desktop/reachability.ts`). This line names the cause once; the screens under it wait for
 * OpenBot and say nothing of their own failures (`lib/desktop/connection-lost.ts`). A browser has its
 * own cues for a site that is down, and a local Desktop has its own status, so neither draws it.
 *
 * It clears on the next request that gets an answer. While it shows the screens' reads wait, so it
 * asks OpenBot itself now and then, backing off, and clears when it answers; the screens fill in
 * then, by themselves.
 *
 * The same bar as the update banner, so it reads as OpenBot's own.
 */
export function ConnectionBanner() {
  const { lost: showing, address } = useConnectionLost();

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

  if (!showing || address === null) return null;
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
