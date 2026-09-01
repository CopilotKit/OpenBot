import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  MAX_RECIPIENTS,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Who a conversation that does not exist yet is with.
 *
 * Uses the same recipient list model as compose state, even while channels are capped at one
 * coworker.
 */
export function RecipientField({
  recipients,
  onChange,
}: {
  recipients: readonly Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const { data: profiles } = useQuery(agentListQueryOptions());
  const [search, setSearch] = useState("");

  const chosen = new Set(recipients.map((recipient) => recipient.id));
  const matches = (profiles ?? [])
    .filter((profile) => !chosen.has(profile.id))
    .filter((profile) =>
      profile.name.toLowerCase().includes(search.trim().toLowerCase()),
    );
  const isFull = recipients.length >= MAX_RECIPIENTS;
  const profileById = new Map(
    (profiles ?? []).map((profile) => [profile.id, profile]),
  );

  return (
    <div className="border-b border-border px-4 py-2">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">To:</span>

        {recipients.map((recipient) => (
          <Button
            key={recipient.id}
            onClick={() => onChange(removeRecipient(recipients, recipient.id))}
            size="xs"
            variant="secondary"
          >
            <ChannelAvatar
              participantIds={[recipient.id]}
              participantImages={[
                profileById.get(recipient.id)?.avatarUrl ?? null,
              ]}
              size={16}
            />
            {recipient.name}
            <span aria-hidden>×</span>
            <span className="sr-only">Remove {recipient.name}</span>
          </Button>
        ))}

        {isFull ? null : (
          <InputGroup className="h-8 w-56 border-none bg-transparent">
            <InputGroupInput
              aria-label="Choose a coworker"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Choose a coworker…"
              value={search}
            />
            <InputGroupAddon />
          </InputGroup>
        )}
      </div>

      {isFull || search.trim().length === 0 ? null : (
        <ul className="mx-auto mt-1 w-full max-w-2xl">
          {matches.map((profile) => (
            <li key={profile.id}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(
                    addRecipient(recipients, {
                      id: profile.id,
                      name: profile.name,
                    }),
                  );
                  setSearch("");
                }}
                type="button"
              >
                <ChannelAvatar
                  participantIds={[profile.id]}
                  participantImages={[profile.avatarUrl]}
                  size={18}
                />
                <span>{profile.name}</span>
                <span className="text-muted-foreground">{profile.title}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No coworker by that name.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
