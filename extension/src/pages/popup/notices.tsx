import { IconInfoCircle } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { RecorderState } from "../../protocol/messages";
import { KEPT_FOR_PERSON_DAYS } from "../../shared/limits";
import type { RecorderNotice } from "../../shared/storage";

const SIGNED_OUT = {
  organization:
    "Your organization sign-in ended. Connect this browser to OpenBot again.",
  default: "This browser was disconnected from OpenBot. Connect it again.",
} as const;

function noticeSentence(notice: RecorderNotice): string {
  switch (notice.kind) {
    case "interrupted":
      return "Your last recording stopped when the browser closed. Everything recorded until then goes to Intelligence.";
    case "signed-out":
      return notice.reason === "organization"
        ? SIGNED_OUT.organization
        : SIGNED_OUT.default;
    case "policy-moved":
      return `Your organization moved the Recorder to ${notice.origin}. Connect it again from OpenBot.`;
  }
}

/** The one notice the service worker holds, above the form, with the kept-events line a sign-out adds. */
export function Notices({
  notice,
  kept,
  onDismiss,
}: {
  notice: RecorderNotice | null;
  kept: RecorderState["kept"];
  onDismiss: () => void;
}) {
  if (!notice) return null;
  const waiting = notice.kind === "signed-out" && kept?.waitingFor;
  return (
    <div className="mb-6">
      <PageRows>
        <Item size="sm" role="status">
          <ItemMedia variant="icon">
            <IconInfoCircle />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="line-clamp-none whitespace-normal font-normal">
              {noticeSentence(notice)}
            </ItemTitle>
            {waiting ? (
              <ItemDescription className="line-clamp-none">
                Your recordings are kept in this browser for up to{" "}
                {KEPT_FOR_PERSON_DAYS} days and sent when you connect again.
              </ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
    </div>
  );
}
