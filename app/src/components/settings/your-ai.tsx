import {
  IconBuilding,
  IconChevronRight,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { removePersonalAiMutationOptions } from "@/lib/ai-connection/mutations";
import { isSignIn, providerById } from "@/lib/ai-connection/providers";
import {
  needsAiConnection,
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import type { AiConnection } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import {
  ChooseConnection,
  Connected,
  Details,
  ProviderTile,
} from "./ai-connection-chooser";
import { failureSaid } from "@/lib/load-failure";

/**
 * Settings → General → Your AI: the AI a person's Bots use when they work for them, on an OpenBot
 * where each person can bring their own (getPersonalAiConnection's `available`, OpenBot Cloud).
 * Theirs alone: it follows them into every organization they are in, and nobody else's runs use it.
 *
 * One row, saying which AI their runs use now: their own, the organization's, or none yet. It opens
 * the same chooser as onboarding's Connect your AI step and the organization's AI connection, in
 * its personal mode. Their own can be removed, and their runs go back to the organization's; where
 * the organization has none and one is required, they are sent to connect another.
 */
export function YourAiSection() {
  const personal = useQuery(personalAiConnectionQueryOptions());
  // Pending, failed, or an OpenBot without this: the section isn't there.
  if (!personal.data?.available) return null;
  return (
    <PageSection
      description="Bots use your own AI when they work for you. It's personal to you and never shared with your organization."
      // Admin → Providers links here.
      id="your-ai"
      title="Your AI"
    >
      <PageRows>
        <YourAiRow personal={personal.data} />
      </PageRows>
    </PageSection>
  );
}

function YourAiRow({ personal }: { personal: PersonalAiConnection }) {
  const [open, setOpen] = useState(false);
  // A new dialog each time it opens, so nothing typed into the last one is kept.
  const [opened, setOpened] = useState(0);
  const described =
    personal.uses === "personal"
      ? describeConnection(personal.connection)
      : null;
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
        {described ? (
          <ProviderTile provider={providerById(personal.connection.provider)} />
        ) : (
          <ItemMedia variant="icon">
            {personal.uses === "organization" ? (
              <IconBuilding />
            ) : (
              <IconSparkles />
            )}
          </ItemMedia>
        )}
        <ItemContent>
          <ItemTitle>
            {described
              ? described.provider
              : personal.uses === "organization"
                ? "Your organization's AI"
                : "Not connected"}
          </ItemTitle>
          <ItemDescription>
            {described
              ? described.summary
              : personal.uses === "organization"
                ? "Bots use the AI your organization set up. Connect your own to use it instead."
                : "Connect your AI so Bots can work for you."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <YourAiDialog
          key={opened}
          onClose={() => setOpen(false)}
          personal={personal}
        />
      </Dialog>
    </>
  );
}

type Step =
  | { at: "current" }
  | { at: "choose" }
  | { at: "done"; connection: AiConnection };

function YourAiDialog({
  personal,
  onClose,
}: {
  personal: PersonalAiConnection;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const own = personal.uses === "personal";
  const described = own ? describeConnection(personal.connection) : null;
  const [step, setStep] = useState<Step>(
    described ? { at: "current" } : { at: "choose" },
  );
  const remove = useMutation(removePersonalAiMutationOptions(queryClient));
  if (step.at === "done")
    return (
      <DialogContent>
        <Connected
          connection={step.connection}
          desktopProblem={null}
          onClose={onClose}
        />
      </DialogContent>
    );
  if (step.at === "choose")
    return (
      <DialogContent>
        <ChooseConnection
          connection={personal.connection}
          mode={{ kind: "personal", signIns: personal.signIns }}
          onBack={described ? () => setStep({ at: "current" }) : onClose}
          onConnected={(next) =>
            setStep({ at: "done", connection: next.connection })
          }
        />
      </DialogContent>
    );
  const afterRemoving = personal.organization.ready
    ? "Remove it and Bots use your organization's AI for you."
    : personal.required
      ? "Remove it and Bots can't work for you until you connect another."
      : "Remove it and Bots stop using it for you.";
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Your AI</DialogTitle>
        <DialogDescription>
          {described
            ? `Bots use ${described.provider} when they work for you. ${
                isSignIn(personal.connection.login)
                  ? "It's yours alone, and OpenBot keeps you signed in."
                  : "It's yours alone, and OpenBot never shows the key."
              }`
            : "You haven't connected your own AI."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
        {described && <Details details={described.details} />}
        <p className="text-muted-foreground">{afterRemoving}</p>
        {remove.error ? (
          <p className="text-destructive" role="alert">
            {failureSaid(remove.error)}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button
          className="mr-auto"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: (after) => {
                onClose();
                if (needsAiConnection(after))
                  void navigate({
                    to: "/onboarding",
                    search: { step: "ai" },
                  });
              },
            })
          }
          size="sm"
          variant="destructive"
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() => setStep({ at: "choose" })}
          size="sm"
        >
          Change
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
