import { IconShare } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
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

/**
 * Requests to use a shared account, for an administrator to approve or decline: one row each,
 * saying what is approved now against what is asked, with the decision beneath. Nothing is drawn
 * for anyone else, or when nothing is waiting.
 */
export function SharedUseRequests() {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const isAdmin = me?.role === "admin";
  const requests = useQuery(sharedUseRequestsQueryOptions(isAdmin));
  const decide = useMutation(decideSharedUseMutationOptions(queryClient));
  if (!isAdmin || !requests.data?.length) return null;

  return (
    <PageSection title="Shared account requests">
      {decide.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      <PageRows>
        {requests.data.map((request, index) => (
          <Fragment key={request.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconShare />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="line-clamp-none">
                  {request.botName} wants the shared {request.title} account
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {WHY[request.reason as SharedUseRequestReason] ??
                    request.reason}
                </ItemDescription>
                <p className="text-sm">
                  Now:{" "}
                  {request.current
                    ? describeApproval(request.current)
                    : "Not approved"}
                </p>
                <p className="text-sm">
                  Asked: {describeApproval(request.proposed)}
                </p>
              </ItemContent>
              <ItemFooter className="justify-start">
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
              </ItemFooter>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
