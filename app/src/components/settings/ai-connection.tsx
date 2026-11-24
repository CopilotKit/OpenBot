import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import { describeConnection } from "@/lib/ai-connection/describe";
import { disconnectAiMutationOptions } from "@/lib/ai-connection/mutations";
import { isSignIn, providerById } from "@/lib/ai-connection/providers";
import {
  aiConnectionQueryOptions,
  desktopAiSupportQueryOptions,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import type { AiConnection } from "@/lib/api/generated/model";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { describeAiConnection } from "@/lib/desktop/ai-connection";
import { changeAiConnectionMutationOptions } from "@/lib/desktop/mutations";
import {
  type DesktopAiConnection,
  desktopAiConnectionQueryOptions,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";
import {
  ChooseConnection,
  Connected,
  Details,
  ProviderTile,
} from "./ai-connection-chooser";
import { failureSaid } from "@/lib/load-failure";

/**
 * Settings → General's AI model: the AI provider OpenBot's Bots run on and how OpenBot signs in to
 * it, with a dialog that changes it while OpenBot keeps running. Never the key itself.
 *
 * Drawn where the server says an admin can change it here (getAiConnection's `editable`). Keys and
 * addresses work in any browser; a plan or a provider sign-in only inside OpenBot Desktop, which
 * holds and renews what they sign in with. An OpenBot older than this operation, or a Desktop older
 * than changing it in place, keeps the row from before: Change there stops OpenBot and opens the
 * setup window.
 *
 * On OpenBot Cloud (a person can set their own AI there, `available`) it is the organization's AI,
 * for everyone in it, beside each person's own in "Your AI" (your-ai.tsx).
 */
export function AiModelSection({
  organizationWide = false,
}: {
  /** Beside "Your AI": this one is the organization's, for everyone in it. */
  organizationWide?: boolean;
}) {
  const connection = useQuery(aiConnectionQueryOptions());
  const support = useQuery(desktopAiSupportQueryOptions());
  if (connection.isPending || support.isPending) return null;
  if (
    connection.error ||
    support.error ||
    connection.data === null ||
    support.data === "older"
  )
    return <DesktopAiModelSection />;
  if (!connection.data.editable) return null;
  return (
    <PageSection
      description={
        organizationWide
          ? "Choose an AI for everyone in your organization. Bots use it for anyone who hasn't connected their own."
          : "Choose the AI provider your Bots use and how OpenBot signs in to it."
      }
      title={organizationWide ? "Organization's AI" : "AI model"}
    >
      <PageRows>
        <AiConnectionRow
          connection={connection.data}
          inDesktop={support.data === "in-place"}
          organizationWide={organizationWide}
        />
      </PageRows>
    </PageSection>
  );
}

/**
 * The organization's AI connection as one row that opens its dialog: what it is, Change, and
 * Disconnect. Settings → General draws it, and so does Admin → Providers.
 */
export function AiConnectionRow({
  connection,
  inDesktop,
  organizationWide,
}: {
  connection: AiConnection;
  inDesktop: boolean;
  organizationWide: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A new dialog each time it opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const viewer = useViewerId(connection);
  const described = describeConnection(
    connection,
    organizationWide ? "organization" : "you",
    viewer,
  );
  const shared = described?.shared;
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
          <ItemTitle>{described?.provider ?? "Not chosen yet"}</ItemTitle>
          {shared ? (
            // An admin's own sign-in, shared: whose, what it does, and whether it still works.
            <ItemDescription className="line-clamp-none">
              {described.summary}{" "}
              {shared.ready ? (
                SHARED_FOR_EVERYONE
              ) : (
                <span className="text-destructive">{SHARED_STOPPED}</span>
              )}
            </ItemDescription>
          ) : (
            <ItemDescription>
              {described?.summary ??
                (organizationWide
                  ? "Choose an AI for everyone in your organization."
                  : "Choose the AI your Bots use.")}
            </ItemDescription>
          )}
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <AiConnectionDialog
          connection={connection}
          inDesktop={inDesktop}
          key={opened}
          onClose={() => setOpen(false)}
          organizationWide={organizationWide}
        />
      </Dialog>
    </>
  );
}

const SHARED_FOR_EVERYONE =
  "Bots across the organization run on it for everyone who hasn't connected their own AI.";
const SHARED_STOPPED =
  "It stopped working. Change it to sign in again or use another provider.";

/**
 * The reader's person id, asked for only where the organization's AI is somebody's shared sign-in,
 * so a sign-in they shared themselves reads as theirs.
 */
function useViewerId(connection: AiConnection): string | undefined {
  return useQuery({
    ...currentUserQueryOptions(),
    enabled: Boolean(connection.sharedSignIn),
  }).data?.id;
}

type Step =
  | { at: "current" }
  | { at: "choose" }
  | { at: "done"; connection: AiConnection; desktopProblem: string | null };

function AiConnectionDialog({
  connection,
  inDesktop,
  onClose,
  organizationWide,
}: {
  connection: AiConnection;
  inDesktop: boolean;
  onClose: () => void;
  organizationWide: boolean;
}) {
  const owner = organizationWide ? "organization" : "you";
  const described = describeConnection(
    connection,
    owner,
    useViewerId(connection),
  );
  const [step, setStep] = useState<Step>(
    described ? { at: "current" } : { at: "choose" },
  );
  const disconnect = useMutation(disconnectAiMutationOptions(queryClient));
  /*
   * On OpenBot Cloud in a plain browser the admin may share their own sign-in as the
   * organization's AI, run by the server as Connect your AI runs it. Inside OpenBot Desktop the
   * chooser keeps Desktop's own plan sign-ins.
   */
  const personal = useQuery({
    ...personalAiConnectionQueryOptions(),
    enabled: organizationWide && !inDesktop,
  }).data;
  const share =
    organizationWide && !inDesktop && personal?.available
      ? {
          signIns: personal.signIns,
          mine:
            personal.connection.ready && isSignIn(personal.connection.login)
              ? personal.connection
              : null,
        }
      : undefined;
  /*
   * Not inside OpenBot Desktop, where a plan's engine runs beside the connection and the switch
   * settles it: there the way off a connection is Change.
   */
  const canDisconnect = described !== null && !inDesktop;
  if (step.at === "done")
    return (
      <DialogContent>
        <Connected
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
          connection={connection}
          mode={{ kind: "organization", inDesktop, organizationWide, share }}
          onBack={described ? () => setStep({ at: "current" }) : onClose}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {organizationWide ? "Organization's AI" : "AI connection"}
        </DialogTitle>
        <DialogDescription>
          {described?.shared
            ? `Bots use ${described.shared.words} for anyone in your organization who hasn't connected their own AI. OpenBot keeps the sign-in and never shows it.`
            : described
              ? organizationWide
                ? `Bots use ${described.provider} for anyone in your organization who hasn't connected their own AI. OpenBot keeps the key and never shows it.`
                : `Your Bots use ${described.provider}. OpenBot keeps the key or sign-in and never shows it.`
              : "Your Bots don't have an AI provider yet."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described && <Details details={described.details} />}
        {described?.shared && !described.shared.ready ? (
          <p className="text-destructive" role="alert">
            {SHARED_STOPPED}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          {organizationWide
            ? "You can switch to another provider or key at any time. Runs that start after that use it."
            : "You can switch to another provider or key while OpenBot keeps running. Your next message uses the new connection."}
        </p>
        {canDisconnect ? (
          <p className="text-muted-foreground">
            {organizationWide
              ? "Disconnect it and Bots work only for people who connected their own AI."
              : "Disconnect it and Bots can't run until you connect another."}
          </p>
        ) : null}
        {disconnect.error ? (
          <p className="text-destructive" role="alert">
            {failureSaid(disconnect.error)}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        {canDisconnect ? (
          <Button
            className="mr-auto"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(undefined, { onSuccess: () => onClose() })
            }
            size="sm"
            variant="destructive"
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : null}
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={disconnect.isPending}
          onClick={() => setStep({ at: "choose" })}
          size="sm"
        >
          Change
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The row from before changing the connection in place: in an OpenBot Desktop older than that, or
 * against an OpenBot server that doesn't offer it. Change there stops OpenBot and opens Desktop's
 * own setup window. Only inside Desktop; a plain browser draws nothing here.
 */
function DesktopAiModelSection() {
  const connection = useQuery(desktopAiConnectionQueryOptions());
  if (desktopShell() === null || !connection.data) return null;
  return (
    <PageSection
      description="Choose the AI provider your Bots use and how OpenBot signs in to it."
      title="AI model"
    >
      <PageRows>
        <DesktopAiConnectionRow connection={connection.data} />
      </PageRows>
    </PageSection>
  );
}

function DesktopAiConnectionRow({
  connection,
}: {
  connection: DesktopAiConnection;
}) {
  const [open, setOpen] = useState(false);
  const change = useMutation(changeAiConnectionMutationOptions());
  const described = describeAiConnection(connection);
  // On success the desktop app is stopping OpenBot, and this page goes with it.
  const stopping = change.isPending || change.isSuccess;
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconSparkles />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{described?.provider ?? "Not chosen yet"}</ItemTitle>
          <ItemDescription>
            {described?.summary ?? "Choose the AI your Bots use."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI connection</DialogTitle>
            <DialogDescription>
              {described
                ? `Your Bots use ${described.provider}. Your key or sign-in stays on this computer.`
                : "Your Bots don't have an AI provider yet."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
            {described && <Details details={described.details} />}
            <p className="text-muted-foreground">
              To change it, OpenBot stops and the setup window opens. OpenBot
              starts again with the connection you choose there.
            </p>
            {change.error ? (
              <p className="text-destructive" role="alert">
                Couldn't open the setup window. Try again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={stopping}
              onClick={() => change.mutate()}
              size="sm"
            >
              {stopping ? "Stopping OpenBot…" : "Change AI connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
