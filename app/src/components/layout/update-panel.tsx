import {
  installProgressSaid,
  outcomeSaid,
  PANEL_TITLES,
  panelState,
  UPDATE_KEEP_WORKING,
  UPDATE_KEEPS_DATA,
  UPDATE_RESTARTS,
  updateOffered,
} from "@openbot/shared/desktop-updates";
import { IconMinus, IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  clearUpdateOutcomeMutationOptions,
  dismissAppUpdateMutationOptions,
  installAppUpdateMutationOptions,
  openLogFolderMutationOptions,
  restartOpenBotMutationOptions,
  restoreAppUpdateMutationOptions,
} from "@/lib/desktop/mutations";
import { desktopAppUpdateQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

/**
 * OpenBot Desktop's update panel: one card in the bottom-right corner of the page that says a newer
 * OpenBot is out, how ready it is, and how the last update went. It is `fixed`, so it floats over
 * the page and never moves it, and it uses theme tokens only, so it fits every skin and both themes.
 *
 * Only inside OpenBot Desktop. The desktop app reads its update feed and this asks the app, so a
 * browser on a self-hosted OpenBot draws nothing and asks nothing. Minimize shrinks the panel to a
 * pill and the desktop app keeps that, until a newer version comes out.
 */
export function UpdatePanel() {
  const install = useMutation(installAppUpdateMutationOptions(queryClient));
  // The shell records the install only after the click, so ask it every half second from the click.
  const offer = useQuery({
    ...desktopAppUpdateQueryOptions(),
    refetchInterval: (query) =>
      install.isPending || query.state.data?.installing
        ? 500
        : query.state.data?.ready?.state === "preparing"
          ? 5_000
          : 60_000,
  });
  const minimize = useMutation(dismissAppUpdateMutationOptions(queryClient));
  const restore = useMutation(restoreAppUpdateMutationOptions(queryClient));
  const clear = useMutation(clearUpdateOutcomeMutationOptions(queryClient));
  const restart = useMutation(restartOpenBotMutationOptions(queryClient));
  const openLog = useMutation(openLogFolderMutationOptions());

  const data = offer.data;
  const state = desktopShell() && data ? panelState(data) : null;
  if (!data || !state) return null;

  const { version, minimized, notes } = data;
  const offered =
    state === "available" || state === "downloading" || state === "ready";

  if (offered && version === null && minimized) {
    return (
      <aside
        aria-label="OpenBot update"
        className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2"
      >
        {restore.error ? (
          <p
            className="rounded-lg border border-border bg-popover p-3 text-destructive text-sm shadow-lg"
            role="alert"
          >
            Couldn't show the update: {reason(restore.error)}
          </p>
        ) : null}
        <Button
          disabled={restore.isPending}
          onClick={() => restore.mutate()}
          size="sm"
          variant="outline"
          className="shadow-lg"
        >
          Update {minimized}
        </Button>
      </aside>
    );
  }

  const outcome = data.outcome ?? null;
  const said = outcome ? outcomeSaid(outcome) : null;
  const title = said?.title ?? PANEL_TITLES[state];
  const line =
    state === "restarting"
      ? installProgressSaid(data.installing)
      : said
        ? said.body
        : updateOffered(version ?? minimized ?? "", data.ready);
  const kept =
    state === "available"
      ? UPDATE_KEEPS_DATA
      : state === "downloading"
        ? UPDATE_KEEP_WORKING
        : state === "ready"
          ? UPDATE_RESTARTS
          : null;
  const busy = install.isPending;

  // A share from 0 to 100, or null when there is no bar or no total to measure by.
  let percent: number | null = null;
  const showBar = state === "downloading" || state === "restarting";
  if (state === "downloading" && data.ready?.state === "preparing") {
    percent =
      data.ready.total > 0
        ? Math.min(99, Math.floor((data.ready.done / data.ready.total) * 100))
        : null;
  } else if (state === "restarting" && data.installing) {
    percent = data.installing.restarting
      ? 100
      : data.installing.total
        ? Math.min(
            100,
            Math.round(
              (data.installing.downloaded / data.installing.total) * 100,
            ),
          )
        : null;
  }

  const error = install.error ?? restart.error ?? openLog.error;

  return (
    <aside
      aria-label="OpenBot update"
      className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground text-sm shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{title}</p>
        {offered ? (
          <Button
            aria-label="Minimize"
            disabled={minimize.isPending || !version}
            onClick={() => version && minimize.mutate(version)}
            size="icon-xs"
            variant="ghost"
          >
            <IconMinus />
          </Button>
        ) : state === "updated" || state === "failed" ? (
          <Button
            aria-label="Close"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            size="icon-xs"
            variant="ghost"
          >
            <IconX />
          </Button>
        ) : null}
      </div>
      {line ? (
        <p
          className="text-muted-foreground"
          role={state === "restarting" ? "status" : undefined}
        >
          {line}
        </p>
      ) : null}
      {kept ? <p className="text-muted-foreground">{kept}</p> : null}
      {showBar ? (
        <div
          aria-label={title}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className={
              percent === null
                ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
                : "h-full rounded-full bg-primary"
            }
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      ) : null}
      {notes && state !== "restarting" && state !== "failed" ? (
        <details open={state === "updated"}>
          <summary className="cursor-pointer text-muted-foreground">
            What's new
          </summary>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-foreground">
            {notes}
          </p>
        </details>
      ) : null}
      {error ? (
        <p className="text-destructive" role="alert">
          {install.error
            ? `Couldn't install the update: ${reason(install.error)}`
            : reason(error)}
        </p>
      ) : null}
      {offered ? (
        <Button disabled={busy} onClick={() => install.mutate()} size="sm">
          Update and restart
        </Button>
      ) : null}
      {state === "failed" ? (
        <div className="flex items-center gap-2">
          <Button
            disabled={restart.isPending}
            onClick={() => restart.mutate()}
            size="sm"
          >
            Try again
          </Button>
          <Button
            disabled={openLog.isPending}
            onClick={() => openLog.mutate()}
            size="sm"
            variant="ghost"
          >
            Open log
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

/** The desktop app refuses with its own sentence, as a plain string. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
