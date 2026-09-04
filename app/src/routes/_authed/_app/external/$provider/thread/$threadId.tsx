import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalThreadChat } from "@/components/channels/external-thread-chat";
import { externalThreadQueryOptions } from "@/lib/external/queries";

export const Route = createFileRoute(
  "/_authed/_app/external/$provider/thread/$threadId",
)({
  component: ExternalThreadPage,
});

function ExternalThreadPage() {
  const { provider, threadId } = Route.useParams();
  const target = useQuery(externalThreadQueryOptions(threadId));

  if (target.isPending) return null;
  if (target.error || !target.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this external conversation.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center border-border border-b px-4">
        <span className="text-sm tracking-tight">
          {provider === "feishu" ? "Feishu" : "Slack"} · {target.data.agentName}
        </span>
      </div>
      <ExternalThreadChat key={target.data.threadId} target={target.data} />
    </div>
  );
}
