import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
import { failureSaid, loadFailure } from "@/lib/load-failure";
import { purgeSavedLoginsMutationOptions } from "@/lib/passwords/mutations";
import {
  passwordKeys,
  unusableSavedLoginsQueryOptions,
} from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

const savedLogins = (count: number) =>
  count === 1 ? "1 saved login" : `${count} saved logins`;

/**
 * Admin, Permissions, under the Password manager switch: delete the saved logins nobody may use any
 * more, those of people the switch is off for and of people no longer in the organization.
 *
 * SHOWN WHENEVER THE SWITCH IS. Whether it is off for anybody depends on each person's role, teams
 * and directory groups, which only the server reads, and the logins of people who left are there
 * whatever the switch says. So the row is always offered, and the counts say what there is.
 *
 * A DIALOG FIRST, WITH THE REAL NUMBERS. It deletes logins, passwords included, for many people at
 * once, and can't be undone. So the dialog reads how many it would delete, for each reason, and the
 * sentence the admin agrees to says so. With nothing to delete it says that, and offers no delete.
 *
 * AN OPENBOT WITHOUT IT. The personal edition shows no Permissions switches, so never this row. An
 * OpenBot released before these operations, which `deployment` can't tell apart, answers the count
 * or the purge with the API's plain not found. The row then says so and stops offering it, and
 * nothing is said as a failure.
 */
export function PurgeSavedLogins() {
  // The row says counts and what to do, so its sentences wrap in full: a row elsewhere stops at two lines.
  const [asking, setAsking] = useState(false);
  const counts = useQuery({
    ...unusableSavedLoginsQueryOptions(),
    enabled: asking,
  });
  const purge = useMutation(purgeSavedLoginsMutationOptions(queryClient));
  const answer = purge.data;
  const notServed = counts.data === null || answer?.served === false;
  const found = counts.data
    ? counts.data.switchedOff + counts.data.removed
    : undefined;
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconTrash />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Saved logins nobody may use</ItemTitle>
          {notServed ? (
            <ItemDescription className="line-clamp-none">
              This OpenBot can't do this yet. Update it first.
            </ItemDescription>
          ) : answer?.served ? (
            <ItemDescription className="line-clamp-none" role="status">
              Deleted {savedLogins(answer.deleted.switchedOff)} of people
              Password manager is off for, and {answer.deleted.removed} of
              people no longer in the organization.
            </ItemDescription>
          ) : (
            <ItemDescription className="line-clamp-none">
              Delete the saved logins of people Password manager is off for, and
              of people no longer in the organization.
            </ItemDescription>
          )}
        </ItemContent>
        {notServed ? null : (
          <ItemActions>
            <Button
              aria-label="Delete saved logins nobody may use"
              onClick={() => {
                purge.reset();
                // Counted afresh each time: never the numbers from an earlier look.
                queryClient.removeQueries({
                  queryKey: passwordKeys.unusable(),
                });
                setAsking(true);
              }}
              size="sm"
              variant="outline"
            >
              Delete
            </Button>
          </ItemActions>
        )}
      </Item>
      <Dialog onOpenChange={setAsking} open={asking && !notServed}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {found === 0
                ? "No saved logins to delete"
                : found === undefined
                  ? "Delete saved logins nobody may use?"
                  : `Delete ${savedLogins(found)}?`}
            </DialogTitle>
            {counts.isPending ? null : counts.error ? (
              <p className="text-destructive text-sm" role="alert">
                {loadFailure(
                  counts.error,
                  "Couldn't count the saved logins. Try again.",
                )}
              </p>
            ) : counts.data && found === 0 ? (
              <DialogDescription>
                Nobody Password manager is off for has a saved login, and nobody
                who left the organization has one.
              </DialogDescription>
            ) : counts.data ? (
              <DialogDescription>
                {counts.data.switchedOff}{" "}
                {counts.data.switchedOff === 1 ? "is" : "are"} from people
                Password manager is off for, and {counts.data.removed} from
                people no longer in the organization. Their passwords are
                deleted with them. You can't undo this.
              </DialogDescription>
            ) : null}
          </DialogHeader>
          {purge.error ? (
            <p className="text-destructive text-sm" role="alert">
              {failureSaid(purge.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setAsking(false)} size="sm" variant="ghost">
              {found === 0 ? "Close" : "Cancel"}
            </Button>
            {found ? (
              <Button
                disabled={purge.isPending}
                onClick={() =>
                  purge.mutate(undefined, {
                    onSuccess: () => setAsking(false),
                  })
                }
                size="sm"
                variant="destructive"
              >
                {purge.isPending ? "Deleting…" : "Delete them"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
