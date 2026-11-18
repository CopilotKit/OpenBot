import {
  APP_UPDATE_SENTENCE,
  type Compatibility,
  SECURITY_UPDATE_SENTENCE,
  SERVER_UPDATE_SENTENCE,
} from "@openbot/shared/client-version";
import { DOESNT_UPDATE_ITSELF } from "@openbot/shared/desktop-updates";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useSyncExternalStore } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { describe } from "@/components/layout/update-banner";
import { Button } from "@/components/ui/button";
import {
  type ClientRefusal,
  clientRefusal,
  subscribeClientRefusal,
} from "@/lib/client-version/refusal";
import {
  type CompatibleApp,
  deploymentCompatibilityQueryOptions,
  THIS_APP,
} from "@/lib/deployment/queries";
import { installAppUpdateMutationOptions } from "@/lib/desktop/mutations";
import { desktopAppUpdateQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";

/**
 * What has to be updated before this app and its OpenBot can work together.
 *
 * - `page`: this page is older than the OpenBot serves. Loading the page again loads the new one.
 * - `desktop`: OpenBot Desktop, around this page, is older than the OpenBot serves. Only its own
 *   update fixes that, so the screen offers OpenBot Desktop's Update and restart.
 * - `server`: the OpenBot is older than this page can use. Only whoever runs it can update it.
 *
 * `security` on the first two: the minimum was raised because of a security problem in older
 * releases, and the screen says so in place of "Update OpenBot".
 */
export type UpdateVerdict =
  | { update: "page"; security?: true }
  | { update: "desktop"; minimum?: string; security?: true }
  | { update: "server" };

/**
 * The verdict, from a refusal this page met and from what the OpenBot's `deployment` says. A refusal
 * comes first: it names the app the OpenBot refused, which inside OpenBot Desktop's window can be
 * OpenBot Desktop itself (its relay adds its own name to every request the page makes).
 */
export function updateVerdict(
  refusal: ClientRefusal | null,
  fit: Compatibility | undefined,
  inDesktop: boolean,
): UpdateVerdict | null {
  if (refusal) {
    const security = refusal.security ? { security: true as const } : {};
    return refusal.client === "desktop" && inDesktop
      ? { update: "desktop", minimum: refusal.minimumVersion, ...security }
      : { update: "page", ...security };
  }
  if (fit?.fit === "app")
    return fit.security
      ? { update: "page", security: true }
      : { update: "page" };
  if (fit?.fit === "server") return { update: "server" };
  return null;
}

/**
 * The app, unless it and its OpenBot can't work together; then one screen that says what to update,
 * in place of the app.
 *
 * At the root, around every route, so it shows before sign-in as well as after, and so nothing that
 * would fail is drawn behind it. Two things decide it: the OpenBot's `deployment`, which it never
 * refuses for the app's version and which the app reads first, and a refusal of any request for
 * being too old an app (`lib/client-version/refusal.ts`), which is how a tab left open across an
 * upgrade finds out. While neither has said anything, or the `deployment` could not be read, the app
 * draws as it always did.
 *
 * `app` is this app; a test names another to see the other verdicts drawn.
 */
export function ClientVersionGate({
  children,
  app = THIS_APP,
}: {
  children: ReactNode;
  app?: CompatibleApp;
}) {
  const refusal = useSyncExternalStore(
    subscribeClientRefusal,
    clientRefusal,
    () => null,
  );
  const fit = useQuery(deploymentCompatibilityQueryOptions(app));
  const verdict = updateVerdict(refusal, fit.data, desktopShell() !== null);
  return verdict ? <UpdateScreen verdict={verdict} /> : children;
}

/**
 * The screen itself: the sign-in screen's frame (the orb, the heading, the column), so it reads as
 * OpenBot's own, with one sentence for a heading and one way forward.
 *
 * No "Reload the page": the same screen shows in OpenBot Desktop's window, which has no reload
 * button. The buttons load the page again themselves.
 */
export function UpdateScreen({ verdict }: { verdict: UpdateVerdict }) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background text-foreground">
      <div className="-mt-12 flex w-full max-w-82 flex-col items-center p-4 text-center">
        <AgentOrb size="56px" />
        {verdict.update === "server" ? (
          <ServerUpdate />
        ) : verdict.update === "desktop" ? (
          <DesktopUpdate
            minimum={verdict.minimum}
            security={verdict.security === true}
          />
        ) : (
          <PageUpdate security={verdict.security === true} />
        )}
      </div>
    </main>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h1 className="mt-8 text-balance text-2xl font-medium tracking-tight">
      {children}
    </h1>
  );
}

function Line({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-balance text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function loadAgain() {
  window.location.reload();
}

/**
 * This page is older than the OpenBot serves: the OpenBot serves the new one on the next load. For a
 * security problem the heading says so and already says what to do, so no line repeats it.
 */
function PageUpdate({ security }: { security: boolean }) {
  return (
    <>
      {security ? (
        <Heading>{SECURITY_UPDATE_SENTENCE}</Heading>
      ) : (
        <>
          <Heading>{APP_UPDATE_SENTENCE}</Heading>
          <Line>This page is from an older version of OpenBot.</Line>
        </>
      )}
      <Button className="mt-8 w-full" onClick={loadAgain} size="lg">
        Update
      </Button>
    </>
  );
}

/** The OpenBot is older than this page can use. Loading again shows whether it has been updated. */
function ServerUpdate() {
  return (
    <>
      <Heading>{SERVER_UPDATE_SENTENCE}</Heading>
      <Line>This OpenBot is on a release this page can't use yet.</Line>
      <Button
        className="mt-8 w-full"
        onClick={loadAgain}
        size="lg"
        variant="outline"
      >
        Try again
      </Button>
    </>
  );
}

/**
 * OpenBot Desktop is older than the OpenBot serves. Its own Update and restart, as the update banner
 * offers it, with how far the download has got; or, on a build that never updates itself, what to
 * do instead.
 */
function DesktopUpdate({
  minimum,
  security,
}: {
  minimum?: string;
  security: boolean;
}) {
  const offer = useQuery(desktopAppUpdateQueryOptions());
  const install = useMutation(installAppUpdateMutationOptions(queryClient));
  const updatesItself = offer.data?.updatesItself !== false;
  const progress = offer.data?.installing ?? null;
  const busy = install.isPending || progress !== null;
  return (
    <>
      <Heading>
        {security ? SECURITY_UPDATE_SENTENCE : APP_UPDATE_SENTENCE}
      </Heading>
      <Line>
        {minimum
          ? `This OpenBot needs OpenBot Desktop ${minimum} or later.`
          : "This OpenBot needs a newer OpenBot Desktop."}
      </Line>
      {offer.isLoading ? null : updatesItself ? (
        <Button
          className="mt-8 w-full"
          disabled={busy}
          onClick={() => install.mutate()}
          size="lg"
        >
          {busy ? describe(progress) : "Update and restart"}
        </Button>
      ) : (
        <Line>{DOESNT_UPDATE_ITSELF}</Line>
      )}
      {install.error && !busy ? (
        <p className="mt-3 text-balance text-sm text-destructive" role="alert">
          Couldn't install the update: {reason(install.error)}
        </p>
      ) : null}
    </>
  );
}

/** The desktop app refuses with its own sentence, as a plain string. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
