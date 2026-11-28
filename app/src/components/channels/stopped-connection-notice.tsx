import { useQuery } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  PROVIDERS_ADDRESS,
  providerAddress,
  providerChangeAddress,
} from "@/lib/ai-connection/paths";
import {
  GOOGLE_SIGN_IN_ENDED,
  PROVIDER_RETIRED,
  providerRetired,
  signInRetired,
} from "@/lib/ai-connection/providers";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { connectionOf } from "@/lib/models/connections";
import {
  conversationModelQueryOptions,
  modelCatalogueQueryOptions,
} from "@/lib/models/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** Open the composer's model picker by pressing its trigger: one conversation is open at a time. */
export function openComposerModelPicker(): void {
  document
    .querySelector<HTMLButtonElement>('[data-slot="composer-model"]')
    ?.click();
}

/**
 * Where a connection is fixed: its own page in Settings → AI providers. `owner` says whose list it is
 * in: on OpenBot Cloud a person's own and the organization's may share an id.
 */
export function reconnectPath(connectionId: string, owner?: string): string {
  return providerAddress(connectionId, owner);
}

/** Where a default is chosen: Settings → AI providers, which says when there is none. */
export function chooseDefaultPath(): string {
  return PROVIDERS_ADDRESS;
}

/**
 * Under a refused turn: the AI connection the conversation's next run would use stopped working,
 * and why, with Reconnect for whoever can fix it and Choose another model for everybody.
 *
 * Mounted only once a turn ended without an answer. It reads the conversation's model choice again
 * then (refused runs change nothing else to read), and draws only when the server says the
 * connection is connected but can't run (`stopped`). The refusal's own words are never matched: the
 * server's sentence varies by connection, and an OpenBot older than several connections sends no
 * `stopped`, which draws nothing here.
 *
 * A connection whose provider OpenBot no longer offers (`provider-retired`) has nothing to
 * reconnect: its way on is Remove it, to the same page, where it is disconnected and another AI
 * connected.
 *
 * Reconnect is a whole page load into Settings → AI providers, as the other ways to fix an AI from a conversation
 * are (add-model-key-link.tsx). It is left out for a member whose runs use the organization's
 * connection: only an admin can fix that one. Named query client, as everything drawn inside a
 * conversation.
 */
export function StoppedConnectionNotice({
  channelId,
  onChooseModel,
  said = [],
}: {
  channelId: string;
  /** Open the composer's model picker. */
  onChooseModel: () => void;
  /**
   * What the conversation already says above the notice (the refusals and the stopped turn): a
   * sentence said there isn't said again here, only the ways on. The server refuses a run on a
   * stopped connection in the same words as its problem.
   */
  said?: readonly string[];
}) {
  const choice = useQuery(
    { ...conversationModelQueryOptions(channelId), refetchOnMount: "always" },
    queryClient,
  ).data;
  const stopped = choice?.stopped ?? null;
  const catalogue = useQuery(
    { ...modelCatalogueQueryOptions(), enabled: stopped !== null },
    queryClient,
  ).data;
  // With no default there is no connection to name: whose they are is any listed one's.
  const owner = stopped
    ? stopped.connection
      ? connectionOf(catalogue, stopped.connection)?.owner
      : catalogue?.connections?.[0]?.owner
    : undefined;
  const me = useQuery(
    { ...currentUserQueryOptions(), enabled: owner === "organization" },
    queryClient,
  ).data;
  if (!stopped) return null;
  // A Google sign-in OpenBot no longer offers: the way on opens Google Gemini's API key directly.
  const retired = signInRetired(stopped);
  // A provider OpenBot no longer offers: nothing reconnects it. Its page is where it is removed.
  const gone = providerRetired(stopped);
  const canFix =
    owner === "personal" ||
    (owner === "organization" && isOrganizationAdmin(me?.role));
  return (
    <div className="flex flex-col items-start gap-2">
      {said.includes(stopped.problem.detail) ? null : (
        <p className="text-destructive text-sm" role="alert">
          {stopped.problem.detail}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canFix ? (
          <a
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            href={
              stopped.connection
                ? retired
                  ? providerChangeAddress(stopped.connection, owner)
                  : reconnectPath(stopped.connection, owner)
                : chooseDefaultPath()
            }
          >
            {stopped.connection
              ? retired
                ? GOOGLE_SIGN_IN_ENDED.action
                : gone
                  ? PROVIDER_RETIRED.remove
                  : "Reconnect"
              : "Choose a default"}
          </a>
        ) : null}
        <Button onClick={onChooseModel} size="sm" variant="outline">
          Choose another model
        </Button>
      </div>
    </div>
  );
}
