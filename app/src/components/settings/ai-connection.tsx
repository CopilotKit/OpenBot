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
import { providerById } from "@/lib/ai-connection/providers";
import {
  aiConnectionQueryOptions,
  desktopAiSupportQueryOptions,
} from "@/lib/ai-connection/queries";
import type { AiConnection } from "@/lib/api/generated/model";
import { describeAiConnection } from "@/lib/desktop/ai-connection";
import { changeAiConnectionMutationOptions } from "@/lib/desktop/mutations";
import {
  type DesktopAiConnection,
  desktopAiConnectionQueryOptions,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import {
  ChooseConnection,
  Connected,
  Details,
  ProviderTile,
} from "./ai-connection-chooser";

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
        />
      </PageRows>
    </PageSection>
  );
}

function AiConnectionRow({
  connection,
  inDesktop,
}: {
  connection: AiConnection;
  inDesktop: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A new dialog each time it opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const described = describeConnection(connection);
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
          <ItemDescription>
            {described?.summary ?? "Choose the AI your Bots use."}
          </ItemDescription>
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
        />
      </Dialog>
    </>
  );
}

type Step =
  | { at: "current" }
  | { at: "choose" }
  | { at: "done"; connection: AiConnection; desktopProblem: string | null };

function AiConnectionDialog({
  connection,
  inDesktop,
  onClose,
}: {
  connection: AiConnection;
  inDesktop: boolean;
  onClose: () => void;
}) {
  const described = describeConnection(connection);
  const [step, setStep] = useState<Step>(
    described ? { at: "current" } : { at: "choose" },
  );
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
          mode={{ kind: "organization", inDesktop }}
          onBack={described ? () => setStep({ at: "current" }) : onClose}
          onConnected={(next) => setStep({ at: "done", ...next })}
        />
      </DialogContent>
    );
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>AI connection</DialogTitle>
        <DialogDescription>
          {described
            ? `Your Bots use ${described.provider}. OpenBot keeps the key or sign-in and never shows it.`
            : "Your Bots don't have an AI provider yet."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described && <Details details={described.details} />}
        <p className="text-muted-foreground">
          You can switch to another provider or key while OpenBot keeps running.
          Your next message uses the new connection.
        </p>
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button onClick={() => setStep({ at: "choose" })} size="sm">
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
