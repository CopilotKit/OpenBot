// The agent's side of a recording: the AG-UI traffic the network capture observes (observation.ts), turned into exactly
// the events the CopilotKit SDK emits for the same traffic, so Intelligence cannot tell a Recorder trajectory from a
// CopilotKit one. This placeholder records nothing yet.
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { AgentObservation } from "./observation";

export type AgentEvents = {
  /** One observation from the network capture, in the order the capture saw it. */
  observe(observation: AgentObservation): void;
  /** A click from a followed tab, before the steps see it: the agent context CopilotKit adds to a click. */
  enrichClick(tabId: number, click: CapturedEvent): CapturedEvent;
  /** The tab's top frame reached another page: its open Threads close. */
  tabNavigated(tabId: number): void;
  /** The recording ended: forget everything held. */
  stop(): void;
};

export function createAgentEvents(_options: {
  /** A masked event ready for the trajectory, in its tab's order. */
  emit(tabId: number, event: CapturedEvent): void;
  /** The recording's sensitive-value digests. */
  digests(): ReadonlySet<string>;
  now(): number;
}): AgentEvents {
  return {
    observe() {},
    enrichClick: (_tabId, click) => click,
    tabNavigated() {},
    stop() {},
  };
}
