import { useQuery } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
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
 * Where a connection is fixed: its row's dialog in Settings, opened by the address. `owner` says
 * whose list it is in: on OpenBot Cloud a person's own and the organization's may share an id.
 */
export function reconnectPath(connectionId: string, owner?: string): string {
  const whose = owner ? `&owner=${encodeURIComponent(owner)}` : "";
  return `/settings?connection=${encodeURIComponent(connectionId)}${whose}`;
}

/** Where a default is chosen: the list in Settings, named by whose it is. */
export function chooseDefaultPath(owner?: string): string {
  return owner ? `/settings?owner=${encodeURIComponent(owner)}` : "/settings";
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
 * Reconnect is a whole page load into Settings, as the other ways to fix an AI from a conversation
 * are (add-model-key-link.tsx). It is left out for a member whose runs use the organization's
 * connection: only an admin can fix that one. Named query client, as everything drawn inside a
 * conversation.
 */
export function StoppedConnectionNotice({
  channelId,
  onChooseModel,
}: {
  channelId: string;
  /** Open the composer's model picker. */
  onChooseModel: () => void;
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
  const canFix =
    owner === "personal" ||
    (owner === "organization" && isOrganizationAdmin(me?.role));
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-destructive text-sm" role="alert">
        {stopped.problem.detail}
      </p>
      <div className="flex flex-wrap gap-2">
        {canFix ? (
          <a
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            href={
              stopped.connection
                ? reconnectPath(stopped.connection, owner)
                : chooseDefaultPath(owner)
            }
          >
            {stopped.connection ? "Reconnect" : "Choose a default"}
          </a>
        ) : null}
        <Button onClick={onChooseModel} size="sm" variant="outline">
          Choose another model
        </Button>
      </div>
    </div>
  );
}
