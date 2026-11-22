import { useEffect, useState } from "react";
import type {
  AgUiEventLike,
  SocketControl,
  SocketRecord,
  StreamControl,
  StreamRecord,
} from "./appContract";

export type StreamPanelProps = {
  streams: StreamControl | null;
  sockets: SocketControl | null;
};

const EVENT_ERROR = "Write an AG-UI event with a type, or a list of them.";
const ALL = "*";

const DEFAULT_EVENT =
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"message-1","delta":"Hello"}';

function isEvent(value: unknown): value is AgUiEventLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** One AG-UI event or a list of them, or null when the text is not that. */
function parseEvents(text: string): AgUiEventLike[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every(isEvent)) return null;
  return list;
}

/** JSON is sent as the parsed value; other text is sent as a string. */
function parseMessage(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function StreamsSection({ streams }: { streams: StreamControl | null }) {
  const [list, setList] = useState<readonly StreamRecord[]>(
    () => streams?.streams() ?? [],
  );
  const [agent, setAgent] = useState(ALL);
  const [text, setText] = useState(DEFAULT_EVENT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (streams === null) {
      setList([]);
      return;
    }
    setList([...streams.streams()]);
    return streams.onChange(() => setList([...streams.streams()]));
  }, [streams]);

  const agents = [
    ...new Set(list.filter((s) => s.open).map((s) => s.agent)),
  ].sort();

  function send() {
    if (streams === null) return;
    const events = parseEvents(text);
    if (events === null) {
      setError(EVENT_ERROR);
      return;
    }
    setError(null);
    streams.push(agent, events);
  }

  return (
    <section>
      <h3>Streams</h3>
      {list.length === 0 ? (
        <p>No streams yet.</p>
      ) : (
        <ul>
          {list.map((stream) => (
            <li key={stream.id} data-testid="stream">
              <code>{stream.agent}</code> <span>{stream.path}</span>{" "}
              <span>{stream.open ? "Open" : "Closed"}</span>{" "}
              <span>{`${stream.sent} sent`}</span>
            </li>
          ))}
        </ul>
      )}
      <label>
        Agent
        <select
          aria-label="Agent"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value={ALL}>* (all)</option>
          {agents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <textarea
        aria-label="Event (JSON)"
        rows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" disabled={streams === null} onClick={send}>
          Send
        </button>
        <button
          type="button"
          disabled={streams === null}
          onClick={() => streams?.end(agent)}
        >
          End the stream
        </button>
      </div>
    </section>
  );
}

function SocketsSection({ sockets }: { sockets: SocketControl | null }) {
  const [list, setList] = useState<readonly SocketRecord[]>(
    () => sockets?.sockets() ?? [],
  );
  const [match, setMatch] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (sockets === null) {
      setList([]);
      return;
    }
    setList([...sockets.sockets()]);
    return sockets.onChange(() => setList([...sockets.sockets()]));
  }, [sockets]);

  function send() {
    if (sockets === null) return;
    const count = sockets.send(match, parseMessage(text));
    setResult(`Sent to ${count} ${count === 1 ? "socket" : "sockets"}.`);
  }

  return (
    <section>
      <h3>Sockets</h3>
      {list.length === 0 ? (
        <p>No sockets yet.</p>
      ) : (
        <ul>
          {list.map((socket) => (
            <li key={socket.id} data-testid="socket">
              <code>{socket.url}</code> <span>{socket.state}</span>{" "}
              <span>{`${socket.received} received`}</span>
            </li>
          ))}
        </ul>
      )}
      <label>
        Address contains
        <input
          aria-label="Address contains"
          value={match}
          onChange={(event) => setMatch(event.target.value)}
        />
      </label>
      <textarea
        aria-label="Message"
        rows={4}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {result && <p role="status">{result}</p>}
      <button type="button" disabled={sockets === null} onClick={send}>
        Send
      </button>
    </section>
  );
}

/** Shows the open AG-UI streams and sockets of the app frame, and sends to them. */
export function StreamPanel(props: StreamPanelProps) {
  return (
    <div>
      <StreamsSection streams={props.streams} />
      <SocketsSection sockets={props.sockets} />
    </div>
  );
}
