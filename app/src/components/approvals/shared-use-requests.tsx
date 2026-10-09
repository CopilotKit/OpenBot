import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  decideSharedUseMutationOptions,
  describeApproval,
  type SharedUseRequestReason,
  sharedUseRequestsQueryOptions,
} from "@/lib/plugins/shared-use";

const WHY: Record<SharedUseRequestReason, string> = {
  refused_call:
    "A call was refused because this Bot reaches more people than approved.",
  publish: "Its owner widened who can reach it.",
  trigger: "Its owner added a trigger that lets outside input steer it.",
  grant: "It was granted the app's actions.",
};

export function SharedUseRequests() {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const isAdmin = me?.role === "admin";
  const requests = useQuery(sharedUseRequestsQueryOptions(isAdmin));
  const decide = useMutation(decideSharedUseMutationOptions(queryClient));
  if (!isAdmin || !requests.data?.length) return null;

  return (
    <div className="space-y-3">
      <h2 className="font-medium">Shared account requests</h2>
      {decide.error ? (
        <p className="text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      {requests.data.map((request) => (
        <article className="space-y-2 rounded-lg border p-4" key={request.id}>
          <h3 className="font-medium text-sm">
            {request.botName} wants the shared {request.title} account
          </h3>
          <p className="text-muted-foreground text-sm">
            {WHY[request.reason as SharedUseRequestReason] ?? request.reason}
          </p>
          <p className="text-sm">
            Now:{" "}
            {request.current
              ? describeApproval(request.current)
              : "Not approved"}
          </p>
          <p className="text-sm">Asked: {describeApproval(request.proposed)}</p>
          <div className="flex gap-2">
            <Button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ id: request.id, decision: "approve" })
              }
              size="sm"
            >
              Approve
            </Button>
            <Button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ id: request.id, decision: "decline" })
              }
              size="sm"
              variant="outline"
            >
              Decline
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
