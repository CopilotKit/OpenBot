import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
import { describeConnection } from "@/lib/ai-connection/describe";
import {
  disconnectAiProviderMutationOptions,
  makeDefaultAiProviderMutationOptions,
} from "@/lib/ai-connection/mutations";
import { providerById } from "@/lib/ai-connection/providers";
import type { AiConnection, AiConnectionSet } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import {
  ChooseConnection,
  Connected,
  Details,
  ProviderTile,
} from "./ai-connection-chooser";

/**
 * Settings → General's AI providers: every provider OpenBot connected at once, as T3 Code keeps
 * its providers. Each conversation picks which one it runs on, and at what thinking, in its model
 * menu; the default is what a conversation starts on and what OpenBot uses for its own work.
 *
 * One row per provider, the default first, each opening a dialog that makes it the default,
 * changes how OpenBot signs in to it, or removes it. Then a row that connects another, through the
 * same chooser as the one connection, in its `additional` mode.
 */
export function AiProviderRows({
  set,
  inDesktop,
  organizationWide,
}: {
  set: AiConnectionSet;
  inDesktop: boolean;
  organizationWide: boolean;
}) {
  return (
    <>
      {set.connections.map((connection) => (
        <div key={connection.provider ?? "none"}>
          <ProviderRow
            connection={connection}
            inDesktop={inDesktop}
            isDefault={connection.provider === set.default}
            // Desktop always runs on one: the last provider is changed, never removed.
            removable={!inDesktop || set.connections.length > 1}
            organizationWide={organizationWide}
          />
          <Separator />
        </div>
      ))}
      <ConnectAnotherRow
        first={set.connections.length === 0}
        inDesktop={inDesktop}
        organizationWide={organizationWide}
      />
    </>
  );
}

function ProviderRow({
  connection,
  isDefault,
  inDesktop,
  removable,
  organizationWide,
}: {
  connection: AiConnection;
  isDefault: boolean;
  inDesktop: boolean;
  removable: boolean;
  organizationWide: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A new dialog each time it opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const described = describeConnection(
    connection,
    organizationWide ? "organization" : "you",
  );
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              setOpened((count) => count + 1);
              setOpen(true);
            }}
            type="button"
          />
        }
        size="sm"
      >
        <ProviderTile provider={providerById(connection.provider)} />
        <ItemContent>
          <ItemTitle>
            {described?.provider ?? connection.provider}
            {isDefault ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-normal text-muted-foreground text-xs">
                Default
              </span>
            ) : null}
          </ItemTitle>
          <ItemDescription>
            {connection.ready
              ? (described?.summary ?? "")
              : "It stopped working. Open it to sign in again or change it."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <ProviderDialog
          connection={connection}
          inDesktop={inDesktop}
          isDefault={isDefault}
          key={opened}
          onClose={() => setOpen(false)}
          organizationWide={organizationWide}
          removable={removable}
        />
      </Dialog>
    </>
  );
}

type Step =
  | { at: "current" }
  | { at: "choose" }
  | { at: "done"; connection: AiConnection; desktopProblem: string | null };

function ProviderDialog({
  connection,
  isDefault,
  inDesktop,
  organizationWide,
  removable,
  onClose,
}: {
  connection: AiConnection;
  isDefault: boolean;
  inDesktop: boolean;
  organizationWide: boolean;
  removable: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ at: "current" });
  const disconnect = useMutation(
    disconnectAiProviderMutationOptions(queryClient, inDesktop),
  );
  const makeDefault = useMutation(
    makeDefaultAiProviderMutationOptions(queryClient, inDesktop),
  );
  const described = describeConnection(
    connection,
    organizationWide ? "organization" : "you",
  );
  const name = described?.provider ?? connection.provider ?? "This provider";
  const busy = disconnect.isPending || makeDefault.isPending;
  // The server can name a provider this app doesn't know: that one can't be removed or made default here.
  const known = providerById(connection.provider)?.id;
  const failure = disconnect.error ?? makeDefault.error;
  if (step.at === "done")
    return (
      <DialogContent>
        <Connected
          connection={step.connection}
          desktopProblem={step.desktopProblem}
          onClose={onClose}
        />
      </DialogContent>
    );
  if (step.at === "choose")
    return (
      <DialogContent>
        <ChooseConnection
          connection={connection}
          mode={{
            kind: "organization",
            inDesktop,
            organizationWide,
            additional: !isDefault,
          }}
          onBack={() => setStep({ at: "current" })}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>
          {isDefault
            ? `New conversations start on ${name}. Pick another provider in a conversation's model menu.`
            : `Conversations can pick ${name}'s models in their model menu.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described ? <Details details={described.details} /> : null}
        {removable ? (
          <p className="text-muted-foreground">
            {isDefault
              ? "Remove it and the next provider you connected becomes the default."
              : "Remove it and conversations that picked it go back to the default."}
          </p>
        ) : null}
        {failure ? (
          <p className="text-destructive" role="alert">
            {failure.message}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        {removable ? (
          <Button
            className="mr-auto"
            disabled={busy}
            onClick={() =>
              known &&
              disconnect.mutate(known, {
                onSuccess: () => onClose(),
              })
            }
            size="sm"
            variant="destructive"
          >
            {disconnect.isPending ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <span className="mr-auto" />
        )}
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        {!isDefault ? (
          <Button
            disabled={busy}
            onClick={() =>
              known &&
              makeDefault.mutate(known, {
                onSuccess: () => onClose(),
              })
            }
            size="sm"
            variant="outline"
          >
            {makeDefault.isPending ? "Saving…" : "Make default"}
          </Button>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => setStep({ at: "choose" })}
          size="sm"
        >
          Change
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const NONE: AiConnection = {
  provider: null,
  login: null,
  model: null,
  endpointHost: null,
  keySet: false,
  ready: false,
  source: "none",
  editable: true,
  saved: [],
  changedAt: null,
};

function ConnectAnotherRow({
  first,
  inDesktop,
  organizationWide,
}: {
  first: boolean;
  inDesktop: boolean;
  organizationWide: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  const [done, setDone] = useState<{
    connection: AiConnection;
    desktopProblem: string | null;
  } | null>(null);
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              setOpened((count) => count + 1);
              setDone(null);
              setOpen(true);
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
          <ItemTitle>
            {first ? "Connect an AI provider" : "Connect another provider"}
          </ItemTitle>
          <ItemDescription>
            {first
              ? "Connect the AI your Bots run on."
              : "Add OpenAI, Anthropic, Google Gemini, xAI or another AI. Conversations pick between them."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent key={opened}>
          {done ? (
            <Connected
              connection={done.connection}
              desktopProblem={done.desktopProblem}
              onClose={() => setOpen(false)}
            />
          ) : (
            <ChooseConnection
              connection={NONE}
              mode={{
                kind: "organization",
                inDesktop,
                organizationWide,
                additional: !first,
              }}
              onBack={() => setOpen(false)}
              onConnected={(next) => setDone(next)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
