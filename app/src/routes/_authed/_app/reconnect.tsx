import { IconCheck, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { PageRows, PageShell } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { appsQueryOptions } from "@/lib/apps/queries";
import { loadFailure } from "@/lib/load-failure";
import { botList, type MovedApp } from "@/lib/moves/moved-apps";
import { clearReconnectReturn, useMovedApps } from "@/lib/moves/use-moved-apps";
import {
  type AdminName,
  withAdmins,
  yourAdmins,
} from "@/lib/organizations/admin-names";
import { useOrganizationAdmins } from "@/lib/organizations/queries";
import { searchTextEntry } from "@/lib/search-text";

/**
 * The apps a move to OpenBot Cloud left to connect again, one row each, for the person to work
 * through before getting back to their Bots.
 *
 * Where a move lands them (after Connect your AI when their organization has no AI yet), and where
 * each app's page brings them back once that app is connected (`useReturnToReconnectList`). An app
 * connected again stays on the list, marked, so the person sees their progress; one they dismiss
 * leaves it. They go on to OpenBot when they choose, or are taken there once the last app is
 * connected. Everything here is read from the server, so a reload, or another device, shows the same.
 *
 * Nobody who never moved has anything here: the page sends them home.
 */
export const Route = createFileRoute("/_authed/_app/reconnect")({
  component: ReconnectPage,
  /*
   * `?notAdded=` is `/reconnect/<appId>` coming back without the app's page: the organization
   * hasn't added the app, and adding it was refused. Read as text, as every report here is.
   */
  validateSearch: (search: Record<string, unknown>): { notAdded?: string } =>
    searchTextEntry("notAdded", search.notAdded),
});

const TITLE = "Reconnect your apps";
/*
 * True of every app listed: one the person signed in to, whose sign-in stayed with the service it
 * was made through, and one meant to come across connected that wasn't, whose row says why. The
 * apps that came across connected are never listed.
 */
const DESCRIPTION =
  "These apps were connected in OpenBot on your computer. Connect each one again here.";

function ReconnectPage() {
  const moved = useMovedApps();
  const { notAdded } = Route.useSearch();
  const navigate = useNavigate();
  // Arriving at the list means no app page is waiting to bring the person back.
  React.useEffect(() => clearReconnectReturn(), []);
  const nothingHere = moved.ready && moved.apps.length === 0;
  React.useEffect(() => {
    if (nothingHere) void navigate({ to: "/", replace: true });
  }, [nothingHere, navigate]);
  // Each app's own mark where the move gave none: the same read `useMovedApps` already made.
  const apps = useQuery({
    ...appsQueryOptions(),
    enabled: moved.listedAny,
  });
  const logos = new Map(
    (apps.data ?? []).map((app) => [app.id, app.logo] as const),
  );
  // Who a member goes to for an app only an admin can turn on, read only when one is listed.
  const admins = useOrganizationAdmins(
    moved.ready &&
      !moved.mayAdd &&
      moved.apps.some((app) => app.cloudId === null && !app.reconnected),
  );

  if (moved.error) {
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-destructive text-sm">
            {loadFailure(
              moved.error,
              "Couldn't load the apps from your move. Try again in a moment.",
            )}
          </p>
          <Button
            disabled={moved.retrying}
            onClick={moved.retry}
            size="sm"
            variant="outline"
          >
            {moved.retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </PageShell>
    );
  }
  if (!moved.ready || nothingHere) {
    return (
      <PageShell description={DESCRIPTION} title={TITLE}>
        {null}
      </PageShell>
    );
  }

  const done = moved.remaining.length === 0;
  return (
    <PageShell
      action={
        <Button
          onClick={() => {
            clearReconnectReturn();
            void navigate({ to: "/" });
          }}
          size="sm"
          variant={done ? "default" : "outline"}
        >
          {done ? "Done" : "Go to OpenBot"}
        </Button>
      }
      description={DESCRIPTION}
      title={TITLE}
    >
      <PageRows>
        {moved.apps.map((app, index) => (
          <React.Fragment key={app.appId}>
            <MovedAppRow
              admins={admins}
              app={app}
              dismissing={moved.dismissing === app.noticeId}
              logo={
                app.iconUrl ??
                (app.cloudId ? logos.get(app.cloudId) : null) ??
                null
              }
              mayAdd={moved.mayAdd}
              notAdded={notAdded === app.appId}
              onDismiss={() => moved.dismiss(app)}
            />
            {index !== moved.apps.length - 1 && <Separator />}
          </React.Fragment>
        ))}
      </PageRows>
      {moved.dismissError ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            moved.dismissError,
            "Couldn't dismiss that app. Try again in a moment.",
          )}
        </p>
      ) : null}
    </PageShell>
  );
}

/** What a moved app's second line says: its account, then which Bots used it. */
export function movedAppSummary(app: MovedApp): string {
  const bots = app.botNames ?? [];
  return [
    app.accountLabel,
    bots.length > 0 ? `Used by ${botList(bots)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Why a moved app can't be connected from here yet, or null when it can: the organization hasn't
 * added it, and either only an admin may (the person isn't one, and is told who they are), or adding
 * it was just refused.
 */
function blockedBecause(
  app: MovedApp,
  mayAdd: boolean,
  notAdded: boolean,
  admins: readonly AdminName[],
): string | null {
  if (app.cloudId !== null) return null;
  if (!mayAdd)
    return withAdmins(
      `An admin has to turn ${app.appName} on before you can connect it.`,
      admins,
    );
  if (notAdded)
    return `Couldn't turn ${app.appName} on here. Try again in a moment.`;
  return null;
}

/**
 * The line under a moved app's summary, or null: why it isn't connected yet. An add refused just
 * now says so first. Otherwise OpenBot Cloud's own reason for an app meant to come across connected
 * (the organization doesn't allow it, say), which already says what to do, with who the admins are
 * beside it when only an admin can act on it; else why it waits for an admin. Nothing once it is
 * connected again.
 */
export function movedAppNote(
  app: MovedApp,
  mayAdd: boolean,
  notAdded: boolean,
  admins: readonly AdminName[],
): { said: string; reason: boolean } | null {
  if (app.reconnected) return null;
  const blocked = blockedBecause(app, mayAdd, notAdded, admins);
  if (blocked && notAdded) return { said: blocked, reason: false };
  if (app.reason) {
    const who = blocked ? yourAdmins(admins) : "";
    return { said: who ? `${app.reason} ${who}` : app.reason, reason: true };
  }
  return blocked ? { said: blocked, reason: false } : null;
}

function MovedAppRow({
  admins,
  app,
  logo,
  mayAdd,
  notAdded,
  dismissing,
  onDismiss,
}: {
  admins: readonly AdminName[];
  app: MovedApp;
  logo: string | null;
  mayAdd: boolean;
  notAdded: boolean;
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const summary = movedAppSummary(app);
  const note = movedAppNote(app, mayAdd, notAdded, admins);
  return (
    <Item data-moved-app={app.appId} size="sm">
      <RowMark>
        <PluginLogo logo={logo} name={app.appName} />
      </RowMark>
      <ItemContent className="min-w-0">
        <ItemTitle>{app.appName}</ItemTitle>
        {summary ? (
          // Whole, never cut: which Bots used it is what tells the person what to check.
          <ItemDescription className="line-clamp-none break-words">
            {summary}
          </ItemDescription>
        ) : null}
        {note ? (
          <ItemDescription
            className="line-clamp-none text-foreground"
            {...(note.reason
              ? { "data-moved-app-reason": "" }
              : { "data-moved-app-blocked": "" })}
          >
            {note.said}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="shrink-0">
        {app.reconnected ? (
          <span className="flex items-center gap-1 text-muted-foreground text-xs">
            <IconCheck aria-hidden="true" className="size-3.5 text-success" />
            Reconnected
          </span>
        ) : (
          <>
            {app.cloudId !== null || mayAdd ? (
              <Button
                render={
                  <Link params={{ appId: app.appId }} to="/reconnect/$appId" />
                }
                size="sm"
              >
                {notAdded && app.cloudId === null ? "Try again" : "Reconnect"}
              </Button>
            ) : null}
            <Button
              aria-label={`Dismiss ${app.appName}`}
              disabled={dismissing}
              onClick={onDismiss}
              size="icon-sm"
              title={`Dismiss ${app.appName}`}
              variant="ghost"
            >
              <IconX />
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
  );
}
