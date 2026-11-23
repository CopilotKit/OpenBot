import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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

const ALL_LABEL = "* (all)";

/** A sentence for an empty list. */
function Nothing({ children }: { children: string }) {
  return (
    <Empty className="p-3">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

const HEAD = "h-8 px-1.5";
const CELL = "px-1.5 py-1";

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
  const id = useId();

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
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Streams</h3>
      {list.length === 0 ? (
        <Nothing>No streams yet.</Nothing>
      ) : (
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={`${HEAD} w-20`}>Agent</TableHead>
              <TableHead className={HEAD}>Path</TableHead>
              <TableHead className={`${HEAD} w-14`}>State</TableHead>
              <TableHead className={`${HEAD} w-16 text-right`}>Sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((stream) => (
              <TableRow key={stream.id} data-testid="stream">
                <TableCell className={`${CELL} truncate font-mono`}>
                  <code title={stream.agent}>{stream.agent}</code>
                </TableCell>
                <TableCell className={`${CELL} truncate font-mono`}>
                  <span title={stream.path}>{stream.path}</span>
                </TableCell>
                <TableCell className={`${CELL} text-muted-foreground`}>
                  {stream.open ? "Open" : "Closed"}
                </TableCell>
                <TableCell className={`${CELL} text-right tabular-nums`}>
                  {`${stream.sent} sent`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-agent`}>Agent</FieldLabel>
        <Select
          value={agent}
          onValueChange={(value) => setAgent(String(value))}
        >
          <SelectTrigger id={`${id}-agent`} size="sm" aria-label="Agent">
            <SelectValue>{agent === ALL ? ALL_LABEL : agent}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{ALL_LABEL}</SelectItem>
            {agents.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Textarea
        aria-label="Event (JSON)"
        rows={6}
        className="font-mono text-xs"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={streams === null} onClick={send}>
          Send
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={streams === null}
          onClick={() => streams?.end(agent)}
        >
          End the stream
        </Button>
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
  const id = useId();

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
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Sockets</h3>
      {list.length === 0 ? (
        <Nothing>No sockets yet.</Nothing>
      ) : (
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD}>Address</TableHead>
              <TableHead className={`${HEAD} w-16`}>State</TableHead>
              <TableHead className={`${HEAD} w-20 text-right`}>
                Received
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((socket) => (
              <TableRow key={socket.id} data-testid="socket">
                <TableCell className={`${CELL} truncate font-mono`}>
                  <code title={socket.url}>{socket.url}</code>
                </TableCell>
                <TableCell className={`${CELL} text-muted-foreground`}>
                  {socket.state}
                </TableCell>
                <TableCell className={`${CELL} text-right tabular-nums`}>
                  {`${socket.received} received`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-match`}>Address contains</FieldLabel>
        <Input
          id={`${id}-match`}
          aria-label="Address contains"
          value={match}
          onChange={(event) => setMatch(event.target.value)}
        />
      </Field>
      <Textarea
        aria-label="Message"
        rows={4}
        className="font-mono text-xs"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {result && (
        <p role="status" className="text-sm text-muted-foreground">
          {result}
        </p>
      )}
      <Button
        size="sm"
        className="self-start"
        disabled={sockets === null}
        onClick={send}
      >
        Send
      </Button>
    </section>
  );
}

/** Shows the open AG-UI streams and sockets of the app frame, and sends to them. */
export function StreamPanel(props: StreamPanelProps) {
  return (
    <div className="flex flex-col gap-6">
      <StreamsSection streams={props.streams} />
      <SocketsSection sockets={props.sockets} />
    </div>
  );
}
