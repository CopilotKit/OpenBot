import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { CONNECT_YOUR_AI_PATH } from "@/components/channels/add-model-key-link";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type AiConnectionOwner,
  connectionName,
  type DescribedConnection,
  describeConnection,
} from "@/lib/ai-connection/describe";
import {
  makeDefaultAiConnectionMutationOptions,
  removeAiConnectionMutationOptions,
} from "@/lib/ai-connection/mutations";
import {
  AI_PROVIDERS,
  isSignIn,
  providerById,
} from "@/lib/ai-connection/providers";
import {
  type AiConnectionEntry,
  type AiConnections,
  aiConnectionQueryOptions,
  type ConnectionScope,
  needsAiConnection,
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import { queryClient } from "@/query-client";
import {
  ChooseConnection,
  Connected,
  Details,
  ProviderTile,
} from "./ai-connection-chooser";

/** What a section's description adds once it lists two or more connections. */
export const SEVERAL =
  "Your Bots can use any of these. Pick a model from any of them in a conversation.";

/**
 * Several AI connections at once, as one row each in Settings and Admin, Providers: the
 * organization's (`organization`) or a person's own on OpenBot Cloud (`personal`). One per
 * provider. A run with no pick uses the default; a person picks a model from any of them in a
 * conversation.
 *
 * Each row opens a dialog to make it the default, change it or disconnect it. The last row
 * connects another AI with the chooser Settings and onboarding share, in its `adding` mode. The
 * server never moves the default by itself, so disconnecting the default asks which one takes
 * over, and connections with no default say so above the rows.
 *
 * The section around it reads the list (aiConnectionsQueryOptions) and draws the single
 * connection it drew before when the server is older than the list.
 */
export function AiConnectionRows({
  list,
  scope,
  inDesktop,
  organizationWide,
}: {
  list: AiConnections;
  scope: ConnectionScope;
  /** Inside an OpenBot Desktop that changes the organization's AI in place. */
  inDesktop: boolean;
  /** The organization's, beside each person's own (OpenBot Cloud). */
  organizationWide: boolean;
}) {
  const { connections } = list;
  const [openId, setOpenId] = useState<string | null>(() =>
    connectionInAddress(connections, scope),
  );
  // A new dialog each time one opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const [adding, setAdding] = useState(false);
  const owner: AiConnectionOwner =
    scope === "organization" && organizationWide ? "organization" : "you";
  const several = connections.length > 1;
  const noDefault =
    connections.length > 0 && !connections.some((entry) => entry.isDefault);
  const unconnected = AI_PROVIDERS.filter(
    (provider) => !connections.some((entry) => entry.provider === provider.id),
  );
  const open = connections.find((entry) => entry.id === openId);
  return (
    <>
      {noDefault ? (
        <p className="mt-4 text-destructive text-sm" role="status">
          No default AI. Choose one so Bots can start work.
        </p>
      ) : null}
      <PageRows>
        {connections.map((entry, index) => (
          <Fragment key={entry.id}>
            {index > 0 ? <Separator /> : null}
            <ConnectionRow
              entry={entry}
              onOpen={() => {
                setOpened((count) => count + 1);
                setOpenId(entry.id);
              }}
              owner={owner}
              tagDefault={several}
            />
          </Fragment>
        ))}
        {unconnected.length > 0 ? (
          <>
            {connections.length > 0 ? <Separator /> : null}
            <Item
              render={
                <button
                  onClick={() => {
                    setOpened((count) => count + 1);
                    setAdding(true);
                  }}
                  type="button"
                />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconPlus />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Connect another AI</ItemTitle>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
      <Dialog
        onOpenChange={(next) => {
          if (!next) setOpenId(null);
        }}
        open={open !== undefined}
      >
        {open ? (
          <ConnectionDialog
            entry={open}
            inDesktop={inDesktop}
            key={opened}
            list={list}
            onClose={() => setOpenId(null)}
            organizationWide={organizationWide}
            owner={owner}
            scope={scope}
          />
        ) : null}
      </Dialog>
      <Dialog onOpenChange={setAdding} open={adding}>
        {adding ? (
          <AddingDialog
            key={opened}
            list={list}
            onClose={() => setAdding(false)}
            owner={owner}
            scope={scope}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/**
 * The connection the address names (`?connection=<id>&owner=<whose>`, a conversation's Reconnect),
 * if this list holds it and the address names this list's owner (or none): a person's own and the
 * organization's may share an id, and only the one meant opens.
 */
function connectionInAddress(
  connections: AiConnectionEntry[],
  scope: ConnectionScope,
): string | null {
  if (typeof window === "undefined") return null;
  const address = new URLSearchParams(window.location.search);
  const id = address.get("connection");
  const owner = address.get("owner");
  if (owner && owner !== scope) return null;
  return id && connections.some((entry) => entry.id === id) ? id : null;
}

function ConnectionRow({
  entry,
  owner,
  tagDefault,
  onOpen,
}: {
  entry: AiConnectionEntry;
  owner: AiConnectionOwner;
  /** Two or more connections: the default says so. */
  tagDefault: boolean;
  onOpen: () => void;
}) {
  const described = describeConnection(entry, owner);
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ProviderTile provider={providerById(entry.provider)} />
      <ItemContent>
        <ItemTitle>
          {connectionName(entry)}
          {tagDefault && entry.isDefault ? (
            <span className="font-normal text-muted-foreground text-xs">
              Default
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {entry.ready ? (
            described?.summary
          ) : (
            <span className="text-destructive">{entry.problem?.detail}</span>
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

type Step =
  | { at: "current" }
  | { at: "disconnect" }
  | { at: "choose" }
  | { at: "fix" }
  | {
      at: "done";
      connection: DescribedConnection;
      desktopProblem: string | null;
      isDefault?: boolean;
    };

function ConnectionDialog({
  entry,
  list,
  scope,
  inDesktop,
  organizationWide,
  owner,
  onClose,
}: {
  entry: AiConnectionEntry;
  list: AiConnections;
  scope: ConnectionScope;
  inDesktop: boolean;
  organizationWide: boolean;
  owner: AiConnectionOwner;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ at: "current" });
  const others = list.connections.filter(
    (other) => other.id !== entry.id && other.ready,
  );
  /*
   * The one connection a removal would leave, which the server then makes the default itself. With
   * more left, the person chooses which takes over, from those that can run.
   */
  const left = list.connections.filter((other) => other.id !== entry.id);
  const onlyOne = left.length === 1 ? left[0] : undefined;
  const choosing = !onlyOne && others.length > 0;
  const [nextDefault, setNextDefault] = useState<string | null>(
    others[0]?.id ?? null,
  );
  const desktop = inDesktop && scope === "organization";
  const makeDefault = useMutation(
    makeDefaultAiConnectionMutationOptions(queryClient, scope),
  );
  const remove = useMutation(
    removeAiConnectionMutationOptions(queryClient, scope),
  );
  const personal = useQuery({
    ...personalAiConnectionQueryOptions(),
    enabled: scope === "personal",
  }).data;
  /**
   * After a removal: a person whose runs now have no AI, where one is required, is sent to connect
   * one, as removing their own AI always did (the server's verdict, read again).
   */
  const afterRemoving = () => {
    onClose();
    if (scope !== "personal") return;
    void queryClient
      .fetchQuery({ ...personalAiConnectionQueryOptions(), staleTime: 0 })
      .then((after) => {
        if (needsAiConnection(after))
          window.location.assign(CONNECT_YOUR_AI_PATH);
      })
      .catch(() => {});
  };
  /*
   * The organization's default, changed as it always was (replaceAiConnection): inside OpenBot
   * Desktop that is the one way to a plan Desktop holds. Every other row connects its provider
   * again, which replaces it.
   */
  const changesInPlace = scope === "organization" && entry.isDefault;
  const current = useQuery({
    ...aiConnectionQueryOptions(),
    enabled: changesInPlace,
  }).data;
  // Inside OpenBot Desktop the default's plan engine runs beside it; the way off it is Change.
  const canDisconnect = !(desktop && entry.isDefault);
  const busy = makeDefault.isPending || remove.isPending;
  const failure = makeDefault.error ?? remove.error;
  const name = connectionName(entry);

  if (step.at === "done")
    return (
      <DialogContent>
        <Connected
          added={step.isDefault === false}
          connection={step.connection}
          desktopProblem={step.desktopProblem}
          onClose={onClose}
          owner={owner}
        />
      </DialogContent>
    );
  if (step.at === "choose")
    return (
      <DialogContent>
        <ChooseConnection
          connection={changesInPlace ? (current ?? undefined) : undefined}
          mode={
            changesInPlace
              ? { kind: "organization", inDesktop, organizationWide }
              : {
                  kind: "adding",
                  scope,
                  signIns: list.signIns,
                  connected: list.connections.map((other) => other.provider),
                }
          }
          onBack={() => setStep({ at: "current" })}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  // A stopped connection, fixed where it is: its provider, ready to sign in again or take a new key.
  if (step.at === "fix")
    return (
      <DialogContent>
        <ChooseConnection
          mode={{
            kind: "adding",
            scope,
            signIns: list.signIns,
            connected: list.connections.map((other) => other.provider),
            provider: entry.provider,
            reconnecting: name,
          }}
          onBack={() => setStep({ at: "current" })}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  if (step.at === "disconnect")
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {name}?</DialogTitle>
          <DialogDescription>
            {onlyOne
              ? `Bots will use ${connectionName(onlyOne)} when nobody picked a model.`
              : choosing
                ? "It's the default AI. Choose which one Bots use when nobody picked a model."
                : lastGoes(scope, organizationWide, personal)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
          {choosing ? (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-muted-foreground">
                Bots will use
              </legend>
              {others.map((other) => (
                <label
                  className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5"
                  key={other.id}
                >
                  <input
                    checked={nextDefault === other.id}
                    name="next-default"
                    onChange={() => setNextDefault(other.id)}
                    type="radio"
                  />
                  {connectionName(other)}
                </label>
              ))}
            </fieldset>
          ) : null}
          {failure ? (
            <p className="text-destructive" role="alert">
              {failure.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={busy}
            onClick={() => setStep({ at: "current" })}
            size="sm"
            variant="ghost"
          >
            Back
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              remove.mutate(
                {
                  id: entry.id,
                  nextDefault: choosing
                    ? others.find((other) => other.id === nextDefault)
                    : undefined,
                  desktop,
                },
                { onSuccess: afterRemoving },
              )
            }
            size="sm"
            variant="destructive"
          >
            {remove.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    );

  const described = describeConnection(entry, owner);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>
          {!entry.ready
            ? entry.problem?.detail
            : entry.isDefault
              ? "Bots use it when nobody picked a model. OpenBot keeps the key or sign-in and never shows it."
              : "Bots use it when someone picks one of its models. OpenBot keeps the key or sign-in and never shows it."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described ? <Details details={described.details} /> : null}
        {!entry.isDefault && !entry.ready ? (
          <p className="text-muted-foreground">
            Fix it before you make it the default.
          </p>
        ) : null}
        {failure ? (
          <p className="text-destructive" role="alert">
            {failure.message}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        {canDisconnect ? (
          <Button
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              if (entry.isDefault) setStep({ at: "disconnect" });
              else
                remove.mutate({ id: entry.id }, { onSuccess: afterRemoving });
            }}
            size="sm"
            variant="destructive"
          >
            {remove.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : null}
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => setStep({ at: "choose" })}
          size="sm"
          variant={entry.isDefault && entry.ready ? "default" : "outline"}
        >
          Change
        </Button>
        {entry.ready ? null : (
          // Stopped: the fix comes first, on its own provider.
          <Button
            disabled={busy}
            onClick={() => setStep({ at: "fix" })}
            size="sm"
          >
            {isSignIn(entry.login) ? "Sign in again" : "Replace key"}
          </Button>
        )}
        {entry.isDefault ? null : (
          <Button
            disabled={busy || !entry.ready}
            onClick={() =>
              makeDefault.mutate({ entry, desktop }, { onSuccess: onClose })
            }
            size="sm"
          >
            {makeDefault.isPending ? "Making it the default…" : "Make default"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * What happens when the last connection that can run goes, in the words the single connection's
 * dialogs always used: a person's runs fall back to the organization's, an organization's on OpenBot
 * Cloud leaves only people with their own, and otherwise Bots can't run.
 */
function lastGoes(
  scope: ConnectionScope,
  organizationWide: boolean,
  personal: PersonalAiConnection | null | undefined,
): string {
  if (scope === "personal")
    return personal?.organization.ready
      ? "Remove it and Bots use your organization's AI for you."
      : personal?.required
        ? "Remove it and Bots can't work for you until you connect another."
        : "Remove it and Bots stop using it for you.";
  return organizationWide
    ? "Disconnect it and Bots work only for people who connected their own AI."
    : "Disconnect it and Bots can't run until you connect another.";
}

function AddingDialog({
  list,
  scope,
  owner,
  onClose,
}: {
  list: AiConnections;
  scope: ConnectionScope;
  owner: AiConnectionOwner;
  onClose: () => void;
}) {
  const [done, setDone] = useState<{
    connection: DescribedConnection;
    desktopProblem: string | null;
    isDefault?: boolean;
  } | null>(null);
  return (
    <DialogContent>
      {done ? (
        <Connected
          added={done.isDefault === false}
          connection={done.connection}
          desktopProblem={done.desktopProblem}
          onClose={onClose}
          owner={owner}
        />
      ) : (
        <ChooseConnection
          mode={{
            kind: "adding",
            scope,
            signIns: list.signIns,
            connected: list.connections.map((entry) => entry.provider),
          }}
          onBack={onClose}
          onConnected={setDone}
        />
      )}
    </DialogContent>
  );
}
