import { updateOffered } from "@openbot/shared/desktop-updates";
import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  dismissAppUpdateMutationOptions,
  installAppUpdateMutationOptions,
} from "@/lib/desktop/mutations";
import {
  type DesktopAppUpdate,
  desktopAppUpdateQueryOptions,
} from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";

/**
 * A slim bar saying a newer OpenBot Desktop is out, with Update and restart, until this person
 * closes it. It says how ready the new version is: downloading in the background while this one
 * keeps running, then ready to install in a few minutes. Update and restart works at any point.
 *
 * Only inside OpenBot Desktop. The desktop app reads its update feed and this asks the app, so a
 * browser on a self-hosted OpenBot draws nothing and asks nothing. Closing it lasts until a newer
 * version comes out, through reloads and restarts, because the app keeps it.
 *
 * The same bar as the self-host one, so it reads as OpenBot's own, and packed from the left for the
 * same reason: CopilotKit's dev inspector floats over the top-right corner on localhost.
 */
export function UpdateBanner() {
  const offer = useQuery(desktopAppUpdateQueryOptions());
  const dismiss = useMutation(dismissAppUpdateMutationOptions(queryClient));
  const install = useMutation(installAppUpdateMutationOptions(queryClient));

  const version = offer.data?.version;
  if (!version) return null;
  const progress = offer.data?.installing ?? null;
  const busy = install.isPending || progress !== null;

  const said = updateOffered(version, offer.data?.ready);

  return (
    <aside
      aria-label="OpenBot update"
      className="flex shrink-0 flex-col border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      {/* One line, as tall as its buttons, in every state, so the page under it never moves as
          the new version downloads and gets ready. A sentence too long for a narrow window is cut
          short, with the whole of it on hover. */}
      <div className="flex h-7 min-w-0 items-center gap-x-2">
        <p className="min-w-0 truncate text-foreground" title={said}>
          {said}
        </p>
        {busy ? (
          <p className="shrink-0 text-muted-foreground" role="status">
            {describe(progress)}
          </p>
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            <Button
              // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
              className="px-0 text-foreground underline"
              onClick={() => install.mutate()}
              size="sm"
              variant="link"
            >
              Update and restart
            </Button>
            <Button
              aria-label="Dismiss"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(version)}
              size="icon-xs"
              variant="ghost"
            >
              <IconX />
            </Button>
          </span>
        )}
      </div>
      {install.error && !busy ? (
        <p className="text-destructive" role="alert">
          Couldn't install the update: {reason(install.error)}
        </p>
      ) : null}
    </aside>
  );
}

/** "Downloading… 25%", then "Restarting…" once it is installed. */
export function describe(progress: DesktopAppUpdate["installing"]): string {
  if (progress?.restarting) return "Restarting…";
  if (!progress?.total) return "Downloading…";
  return `Downloading… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
}

/** The desktop app refuses with its own sentence, as a plain string. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
