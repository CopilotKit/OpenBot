import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  IconAlertTriangle,
  IconHandStop,
  IconPlugOff,
} from "@tabler/icons-react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { AttentionItem } from "@/lib/attention/queries";
import { attentionListQueryOptions } from "@/lib/attention/queries";
import { resolveAttentionMutationOptions } from "@/lib/attention/mutations";
import { queryClient } from "@/query-client";

/**
 * What is waiting on a person: boundary refusals and stalled runs, drawn from the trail and gone
 * once somebody marks them handled. The trail itself keeps everything; this page is only what is
 * open now.
 */

export const Route = createFileRoute("/_authed/_app/attention")({
  component: AttentionPage,
});

const KIND_WORDS: Record<AttentionItem["kind"], string> = {
  refused: "Action refused",
  tool_rejected: "Tool call refused",
  stalled: "Run stalled",
};

function KindIcon({ kind }: { kind: AttentionItem["kind"] }) {
  if (kind === "stalled") return <IconPlugOff />;
  if (kind === "tool_rejected") return <IconHandStop />;
  return <IconAlertTriangle />;
}

function AttentionPage() {
  const items = useQuery(attentionListQueryOptions());
  const resolve = useMutation(resolveAttentionMutationOptions(queryClient));

  return (
    <PageShell
      description={
        <>
          Refusals and stalled runs that nobody has handled yet. Everything here
          is already recorded in the trail; marking an item handled clears it
          for everyone and says who did.
        </>
      }
      title="Attention"
    >
      <PageSection title="Waiting on you">
        {items.isPending ? null : items.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            The attention list could not be loaded.
          </p>
        ) : items.data?.length === 0 ? (
          <p className="mt-2 text-muted-foreground text-sm">
            Nothing is waiting. A refusal or a stalled run will appear here.
          </p>
        ) : (
          <PageRows>
            {items.data?.map((item, index) => (
              <div key={item.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <KindIcon kind={item.kind} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {KIND_WORDS[item.kind]} · {item.botId}
                    </ItemTitle>
                    <ItemDescription>
                      {item.sentence}{" "}
                      <span className="whitespace-nowrap">
                        {new Date(item.at).toLocaleString()}
                      </span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      render={(props) => (
                        <Link
                          {...props}
                          to="/bot"
                          search={{ agent: item.botId }}
                        />
                      )}
                      size="sm"
                      variant="ghost"
                    >
                      Open Bot
                    </Button>
                    <Button
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate(item.id)}
                      size="sm"
                      variant="outline"
                    >
                      {resolve.isPending ? "Resolving…" : "Resolve"}
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {resolve.error ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {resolve.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
