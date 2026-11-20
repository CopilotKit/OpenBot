// What the network capture sees of the AG-UI traffic in a followed tab, over any transport (an SSE or protobuf response
// to a run, or the Intelligence WebSocket), handed to the agent events (events.ts) that turn it into the events the
// CopilotKit SDK emits. Everything here is raw and unmasked: it stays in the service worker's memory, and only the agent
// events' masked output leaves.

/** The run a page started: the JSON it posted, already unwrapped from CopilotKit's single-route `{ method, params, body }`
 * envelope. `input` is the AG-UI `RunAgentInput` as the page sent it (threadId, runId, messages, state, tools, context,
 * forwardedProps), unvalidated. */
export type AgentRunRequest = {
  kind: "request";
  tabId: number;
  /** One per response or channel: every observation of the same SSE response, protobuf response or WebSocket channel
   * shares it. */
  streamId: string;
  /** Epoch milliseconds when the capture saw it. */
  at: number;
  url: string;
  /** From the URL (`/agent/<id>/run`, `/agent/<id>/connect`) or the envelope's `params.agentId`; null when neither has it. */
  agentId: string | null;
  method: "agent/run" | "agent/connect";
  input: unknown;
};

/** One AG-UI event, as received, in the order its stream delivered it. */
export type AgentStreamEvent = {
  kind: "event";
  tabId: number;
  streamId: string;
  at: number;
  /** Known from the stream's request or channel; null when the stream named none. */
  agentId: string | null;
  /** Known from the stream's request or channel (the Intelligence channel's join); null when the stream named none. */
  threadId: string | null;
  /** The event object (`type`, and the fields of that type), unvalidated. */
  event: unknown;
};

/** A stream is over: its response finished or failed, or its channel closed. */
export type AgentStreamEnd = {
  kind: "end";
  tabId: number;
  streamId: string;
  at: number;
  outcome: "complete" | "failed";
};

/** The page asked its CopilotKit runtime what it serves (CopilotKit's `info` call: a GET or POST of `<runtime>/info`, or
 * the single route's `{ method: "info" }`), and the runtime answered as CopilotKit's does: the page runs CopilotKit,
 * so a click there carries the open-Thread context CopilotKit adds, `threadId: null` while no Thread is open. */
export type AgentRuntimeInfo = {
  kind: "runtime";
  tabId: number;
  /** Epoch milliseconds when the answer was seen. */
  at: number;
  url: string;
};

export type AgentObservation =
  | AgentRunRequest
  | AgentStreamEvent
  | AgentStreamEnd;

/** Everything the network capture hands the agent events: the AG-UI streams, and that the page runs CopilotKit. */
export type CaptureObservation = AgentObservation | AgentRuntimeInfo;
