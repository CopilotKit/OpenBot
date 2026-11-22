import { useState } from "react";
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
    <section>
      <h3>Events</h3>
      <select
        aria-label="Event"
        value={event}
        onChange={(e) => {
          const next = e.target.value as EventName;
          setEvent(next);
          setText(defaultText(next));
          setError(null);
        }}
      >
        {EVENTS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Payload (JSON)"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={!control} onClick={send}>
        Send
      </button>
    </section>
  );
}
