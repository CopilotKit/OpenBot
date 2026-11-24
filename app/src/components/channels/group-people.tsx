import { IconUser, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PeopleTypeahead } from "@/components/teams/people-typeahead";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
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
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  groupQueryOptions,
  removeGroupMemberMutationOptions,
} from "@/lib/groups";
import { failureSaid } from "@/lib/load-failure";
import { personName } from "@/lib/organizations/words";
import type { OrganizationPerson } from "@/lib/teams/queries";

/**
 * Who is in a group, from its top bar: how many people, and a dialog listing them where the creator
 * can take someone out, anyone else can leave, and anyone in it can add a member of the
 * organization, found by name or address as they type. Everyone added sees the whole conversation.
 */
export function GroupPeopleButton({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const add = useMutation(
    addGroupMemberMutationOptions(queryClient, channelId),
  );
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const [open, setOpen] = useState(false);
  // Chosen and not yet answered, and the last person added, for a screen reader.
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [last, setLast] = useState<OrganizationPerson | null>(null);
  const people = group.data?.people ?? [];
  // Who is in it already, by id and by address, so they are offered as such.
  const inGroup = new Set(
    people.flatMap((person) => [person.userId, person.email.toLowerCase()]),
  );
  if (!group.data) return null;
  const iCreated = people.some(
    (person) => person.creator && person.userId === me?.id,
  );
  const count = `${people.length} ${people.length === 1 ? "person" : "people"}`;

  return (
    <>
      <Button
        className="ml-auto"
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        <IconUsers />
        {count}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>People in this group</DialogTitle>
            <DialogDescription>
              Everyone here sees the whole conversation. Every Bot in it answers
              them.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
            <div className="overflow-hidden rounded-lg">
              {people.map((person, index) => {
                const self = person.userId === me?.id;
                const removable = self ? !person.creator : iCreated;
                return (
                  <Fragment key={person.userId}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm" variant="muted">
                      <ItemMedia variant="icon">
                        <IconUser />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {self ? "You" : (person.name ?? person.email)}
                        </ItemTitle>
                        <ItemDescription>
                          {person.creator ? "Started this group" : person.email}
                        </ItemDescription>
                      </ItemContent>
                      {removable ? (
                        <ItemActions>
                          <Button
                            aria-label={
                              self
                                ? "Leave this group"
                                : `Remove ${person.email}`
                            }
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(person.userId)}
                            size="sm"
                            variant="outline"
                          >
                            {self ? "Leave" : "Remove"}
                          </Button>
                        </ItemActions>
                      ) : null}
                    </Item>
                  </Fragment>
                );
              })}
            </div>
            {/*
              Somebody is added from the organization's own members, found as they are typed:
              nobody outside it can be found or added here.
            */}
            <PeopleTypeahead
              announcement={
                last ? `${personName(last)} added to this group` : undefined
              }
              autoFocus={false}
              label="People to add to this group"
              onChoose={(person) => {
                setAdding((now) => new Set([...now, person.id]));
                add.mutate(person.email, {
                  onSuccess: () => setLast(person),
                  onSettled: () =>
                    setAdding(
                      (now) =>
                        new Set([...now].filter((one) => one !== person.id)),
                    ),
                });
              }}
              unavailable={(person) =>
                inGroup.has(person.id) ||
                inGroup.has(person.email.toLowerCase()) ||
                adding.has(person.id)
                  ? "In this group"
                  : person.email.trim()
                    ? null
                    : "Hasn't signed in yet"
              }
            />
            {add.error || remove.error ? (
              <p className="text-destructive text-sm" role="alert">
                {failureSaid(add.error ?? remove.error)}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
