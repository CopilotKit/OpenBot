import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { NativeControl } from "../src/fakeNative/control";
import { EVENTS, type EventName } from "../src/fakeNative/registry";

export type EventsPanelProps = { control: NativeControl | null };

const DEFAULTS: Partial<Record<EventName, string>> = {
  "setup:progress":
    '{"step":"engine","ok":true,"running":true,"detail":"Starting the software OpenBot runs on."}',
  "setup:downloads":
    '{"state":"downloading","bytes":100000000,"size":600000000}',
};

function defaultText(event: EventName): string {
  return DEFAULTS[event] ?? "null";
}

/** Sends any event the desktop window listens for, with a payload you edit. */
export function EventsPanel({ control }: EventsPanelProps) {
  const [event, setEvent] = useState<EventName>(EVENTS[0]);
  const [text, setText] = useState(defaultText(EVENTS[0]));
  const [error, setError] = useState<string | null>(null);

  function send() {
    if (!control) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`The payload is not valid JSON: ${message}`);
      return;
    }
    setError(null);
    control.emit(event, payload);
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Events</h3>
      <Select
        value={event}
        onValueChange={(value) => {
          const next = value as EventName;
          setEvent(next);
          setText(defaultText(next));
          setError(null);
        }}
      >
        <SelectTrigger size="sm" aria-label="Event" className="font-mono">
          <SelectValue>{event}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {EVENTS.map((name) => (
            <SelectItem key={name} value={name} className="font-mono">
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        aria-label="Payload (JSON)"
        rows={6}
        className="font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        size="sm"
        className="self-start"
        disabled={!control}
        onClick={send}
      >
        Send
      </Button>
    </section>
  );
}
