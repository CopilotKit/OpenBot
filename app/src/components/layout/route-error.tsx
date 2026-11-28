import { useMutation, useQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import {
  isChunkLoadError,
  recoverChunk,
  thisBuild,
} from "@/lib/chunk-recovery";
import { openLogFolderMutationOptions } from "@/lib/desktop/mutations";
import { desktopStatusQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { errorDetails } from "@/lib/error-details";
import { queryClient } from "@/query-client";

/**
 * OpenBot's screen for a route that failed, in place of the router's own "Something went wrong!"
 * box with the error's text in it.
 *
 * A part of the app that couldn't be fetched is fetched again first (`lib/chunk-recovery.ts`): once
 * the OpenBot answers, the page loads again by itself, once, and gets the build the OpenBot serves,
 * the new one when a release replaced this page's. Nothing is drawn meanwhile, so a page that
 * recovers never flashes an error.
 *
 * When that is spent, or the route failed some other way, the screen says what failed in plain
 * words and offers what helps: Reload, which loads the page again itself (OpenBot Desktop's window
 * has no reload button), the error's details to copy into a bug report, and in OpenBot Desktop its
 * log folder, as Settings offers them.
 *
 * Drawn where the route was: in the pane beside the sidebar, or the whole window when the route
 * was the whole window. The frame is the sign-in screen's, as the other whole-page answers are
 * (`NoOrganizationPage`, `UpdateScreen`).
 */
export function RouteError({ error }: ErrorComponentProps) {
  const chunk = isChunkLoadError(error);
  const [stuck, setStuck] = useState(() => !chunk);

  useEffect(() => {
    if (stuck) return;
    let cancelled = false;
    void recoverChunk(() => !cancelled).then((next) => {
      // While the page loads again, nothing more is drawn.
      if (!cancelled && next === "stuck") setStuck(true);
    });
    return () => {
      cancelled = true;
    };
  }, [stuck]);

  if (!stuck)
    return (
      <div aria-busy="true" className="flex-1" role="status">
        <span className="sr-only">Loading</span>
      </div>
    );

  return <RouteErrorScreen chunk={chunk} error={error} />;
}

function RouteErrorScreen({
  chunk,
  error,
}: {
  chunk: boolean;
  error: unknown;
}) {
  const shell = desktopShell() !== null;
  // The app's own client, named: an error screen can be drawn above wherever it is provided.
  const status = useQuery(
    { ...desktopStatusQueryOptions({ memory: false }), enabled: shell },
    queryClient,
  );
  const logFolder = shell ? (status.data?.logFolder ?? null) : null;
  const openLogs = useMutation(openLogFolderMutationOptions(), queryClient);
  const [copied, setCopied] = useState<boolean | "failed">(false);
  const [at] = useState(() => new Date());

  const details = errorDetails(error, {
    path: window.location.pathname,
    build: thisBuild()?.split("/").pop() ?? null,
    desktop: status.data
      ? `OpenBot Desktop ${status.data.version} (${status.data.build})`
      : null,
    userAgent: navigator.userAgent,
    at,
  });

  return (
    <div className="flex min-h-dvh w-full flex-1 flex-col items-center justify-center in-data-[slot=sidebar-inset]:min-h-0">
      <div className="-mt-12 flex w-full max-w-82 flex-col items-center p-4 text-center">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-balance font-medium text-2xl tracking-tight">
          {chunk ? "This page didn't load" : "Something went wrong"}
        </h1>
        <p className="mt-3 text-balance text-muted-foreground text-sm">
          {chunk
            ? "OpenBot couldn't download part of this page. Reload to try again."
            : "OpenBot ran into a problem showing this page. Reload to try again."}
        </p>
        <Button
          className="mt-8 h-10 w-full tracking-tight"
          onClick={() => window.location.reload()}
          size="lg"
        >
          Reload
        </Button>
        <p className="mt-8 text-balance text-muted-foreground text-sm">
          {logFolder
            ? "If it keeps happening, share these details and your logs when you ask for help."
            : "If it keeps happening, share these details when you ask for help."}
        </p>
        <section aria-label="Error details" className="w-full">
          <pre className="mt-3 max-h-32 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/50 px-3 py-2 text-left font-mono text-muted-foreground text-xs">
            {details}
          </pre>
        </section>
        <div className="mt-3 flex w-full flex-col gap-2">
          <Button
            className="h-10 w-full tracking-tight"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(details);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied("failed");
              }
            }}
            size="lg"
            variant="outline"
          >
            {copied === true ? "Copied" : "Copy details"}
          </Button>
          {copied === "failed" ? (
            <p className="text-balance text-destructive text-sm" role="alert">
              Couldn't copy the details. Select them above and copy them.
            </p>
          ) : null}
          {logFolder ? (
            <Button
              className="h-10 w-full tracking-tight"
              disabled={openLogs.isPending}
              onClick={() => openLogs.mutate()}
              size="lg"
              variant="outline"
            >
              Open log folder
            </Button>
          ) : null}
          {openLogs.error ? (
            <p className="text-balance text-destructive text-sm" role="alert">
              Couldn't open the log folder. Find it at {logFolder}.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
