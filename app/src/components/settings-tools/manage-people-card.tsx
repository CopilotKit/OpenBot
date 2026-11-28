import {
  IconShieldCheck,
  IconUser,
  IconUserMinus,
  IconUserPlus,
} from "@tabler/icons-react";
import { useState } from "react";
import { copyText } from "@/components/settings/linked-accounts";
import { Button } from "@/components/ui/button";
import { invitationLink } from "@/lib/organizations/words";
import {
  type AdminCardState,
  AdminChangeCard,
  AdminChangeDetails,
} from "./admin-card-parts";
import type { ChangeView, PeopleResult } from "./admin-tool-results";

/**
 * `manage_people`: an invitation, a change between admin and member, or a removal, drawn as the
 * Members list on Organization settings draws a person, with their role before and after. An
 * invitation that wasn't emailed offers its link, as the invite dialog does.
 */

/** The mark for what was asked: the tool's own `action` and `role`, from its result or its arguments. */
function iconOf(asked: { action?: unknown; role?: unknown } | undefined) {
  if (asked?.action === "invite") return IconUserPlus;
  if (asked?.action === "remove") return IconUserMinus;
  return asked?.role === "admin" ? IconShieldCheck : IconUser;
}

export function ManagePeopleCard({
  result,
  asked,
  state,
  message,
}: {
  result?: PeopleResult;
  /** What the Bot asked for, which says what the card is about before there's a result. */
  asked?: { action?: unknown; role?: unknown };
  state: AdminCardState;
  message?: string;
}) {
  return (
    <AdminChangeCard
      caption={result ? `${result.organization} · Members` : "Members"}
      footer={
        result && state === "done" && result.action === "invite" ? (
          <InvitationNote result={result} />
        ) : null
      }
      icon={iconOf(
        result ? { action: result.action, role: result.person.role } : asked,
      )}
      message={message}
      result={result}
      state={state}
      title={result?.summary ?? "Manage people"}
    />
  );
}

/** How the person invited hears of it: OpenBot emailed them, or here's the link to send. */
function InvitationNote({ result }: { result: PeopleResult }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  if (result.delivery === "emailed")
    return (
      <p className="text-muted-foreground text-sm">
        We emailed {result.person.email} an invitation.
      </p>
    );
  if (!result.invitationId) return null;
  const link = invitationLink(result.invitationId);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-sm">
        Copy the link and send it to {result.person.email}.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 py-1.5 pr-1.5 pl-3 dark:border-transparent dark:bg-muted/30">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {link}
        </span>
        <Button
          aria-label={`Copy link for ${result.person.email}`}
          onClick={async () =>
            setCopied(await copyText(link, navigator.clipboard))
          }
          size="sm"
          variant="outline"
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copied === false ? (
        <p className="text-destructive text-xs" role="alert">
          Couldn't copy the link. Select it and copy it yourself.
        </p>
      ) : null}
    </div>
  );
}

/** What the approval card shows while it waits. */
export function ManagePeopleApproval({
  change,
  asked,
}: {
  change: ChangeView;
  asked?: { action?: unknown; role?: unknown };
}) {
  return <AdminChangeDetails headline icon={iconOf(asked)} result={change} />;
}
