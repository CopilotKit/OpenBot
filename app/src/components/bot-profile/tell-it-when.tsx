import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { AgentProfile } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";

/**
 * "Tell {Bot} when to work": one sentence that opens a conversation with the Bot, which sets up the
 * routine from it. Sits inside a settings section and draws no heading of its own.
 *
 * Enter does not send, since a sentence can wrap; the button does. A start that fails keeps the
 * sentence so it can be sent again.
 */
export function TellItWhen({
  agent,
}: {
  agent: Pick<AgentProfile, "id" | "name">;
}) {
  const fieldId = useId();
  const { start } = useStartChannel({ replace: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const send = async () => {
    setSending(true);
    setFailed(false);
    try {
      await start(agent.id, text.trim());
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor={fieldId}>Tell {agent.name} when to work</FieldLabel>
      <Textarea
        id={fieldId}
        onChange={(event) => setText(event.target.value)}
        placeholder="Every weekday at 9, send me yesterday's new leads."
        value={text}
      />
      {failed ? (
        <p className="text-destructive text-sm" role="alert">
          Couldn't start the conversation. Try again in a moment.
        </p>
      ) : null}
      <Button
        className="self-end"
        disabled={sending || text.trim() === ""}
        onClick={send}
      >
        {sending ? "Sending…" : "Send"}
      </Button>
    </Field>
  );
}
