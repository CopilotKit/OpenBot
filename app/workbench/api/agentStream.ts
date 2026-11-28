/*
 * The AG-UI stream registry of the app frame. It answers the CopilotKit runtime's run and connect
 * requests with a `text/event-stream` body that stays open, and a run step writes AG-UI events
 * into it.
 *
 * The paths, as the client sends them (read in
 * node_modules/@copilotkit/core/dist/index.mjs, ProxiedCopilotRuntimeAgent, @copilotkit/core 1.88.0):
 *   - run:     `${runtimeUrl}/agent/${encodeURIComponent(agentId)}/run`  (via HttpAgent.run)
 *   - connect: `${runtimeUrl}/agent/${agentId}/connect`
 * Both are POST with a JSON body (HttpAgent.requestInit in @ag-ui/client 1.0.2). The agent id is in
 * the path. The app sets `runtimeUrl="/api/copilotkit"` (app/src/lib/copilot/provider.tsx). The
 * client uses these REST paths when `GET .../info` answers 2xx; this file does not answer `/info`.
 */
import { HttpResponse, http, type RequestHandler } from "msw";
import type {
  AgUiEventLike,
  StreamControl,
  StreamRecord,
} from "../../../desktop/workbench/appContract";

export const RUN_PATH = "*/api/copilotkit/agent/:agentId/run";
export const CONNECT_PATH = "*/api/copilotkit/agent/:agentId/connect";

/** The agent name that means "every agent". */
const ANY = "*";

type OpenStream = {
  record: StreamRecord;
  controller: ReadableStreamDefaultController<Uint8Array>;
};

type Queued = { agent: string; event: AgUiEventLike };

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createAgentStreams(): StreamControl & {
  handlers: RequestHandler[];
} {
  const encoder = new TextEncoder();
  const records: StreamRecord[] = [];
  const open = new Map<number, OpenStream>();
  /** Events for an agent with no open stream, in the order they were pushed. */
  let queue: Queued[] = [];
  /** Agents whose next stream closes after its queue. */
  const pendingEnd = new Set<string>();
  const listeners = new Set<() => void>();
  let nextId = 1;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const matches = (stream: OpenStream, agent: string) =>
    agent === ANY || stream.record.agent === agent;

  const write = (stream: OpenStream, event: AgUiEventLike) => {
    stream.controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
    );
    stream.record.sent += 1;
  };

  const close = (stream: OpenStream) => {
    open.delete(stream.record.id);
    stream.record.open = false;
    try {
      stream.controller.close();
    } catch {
      // The consumer cancelled it already.
    }
  };

  const openStream = (agent: string, path: string): ReadableStream => {
    const record: StreamRecord = {
      id: nextId++,
      agent,
      path,
      open: true,
      sent: 0,
    };
    records.push(record);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const stream: OpenStream = { record, controller };
        open.set(record.id, stream);
        const mine = queue.filter(
          (item) => item.agent === agent || item.agent === ANY,
        );
        queue = queue.filter(
          (item) => item.agent !== agent && item.agent !== ANY,
        );
        for (const item of mine) write(stream, item.event);
        const endAgent = pendingEnd.has(agent)
          ? agent
          : pendingEnd.has(ANY)
            ? ANY
            : null;
        if (endAgent !== null) {
          pendingEnd.delete(endAgent);
          close(stream);
        }
        notify();
      },
      cancel() {
        open.delete(record.id);
        record.open = false;
        notify();
      },
    });
  };

  const answer = (agentId: string, url: string) =>
    new HttpResponse(openStream(decode(agentId), new URL(url).pathname), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });

  const handlers: RequestHandler[] = [
    http.post(RUN_PATH, ({ params, request }) =>
      answer(String(params.agentId), request.url),
    ),
    http.post(CONNECT_PATH, ({ params, request }) =>
      answer(String(params.agentId), request.url),
    ),
  ];

  return {
    handlers,
    streams: () => records.map((record) => ({ ...record })),
    push(agent, events) {
      const targets = [...open.values()].filter((stream) =>
        matches(stream, agent),
      );
      if (targets.length === 0) {
        for (const event of events) queue.push({ agent, event });
      } else {
        for (const stream of targets) {
          for (const event of events) write(stream, event);
        }
      }
      notify();
    },
    end(agent) {
      const targets = [...open.values()].filter((stream) =>
        matches(stream, agent),
      );
      if (targets.length === 0) pendingEnd.add(agent);
      for (const stream of targets) close(stream);
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
