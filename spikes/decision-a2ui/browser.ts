import type { A2uiSurface } from "@a2ui/lit";
import "@a2ui/lit";
import {
  basicCatalog,
  MessageProcessor,
  type ActionMessage,
  type AgentToRendererMessage,
  type WebComponentImplementation,
} from "@a2ui/web_core/v1_0";

declare global {
  interface Window {
    lastA2uiAction?: ActionMessage;
    replayA2ui(messages: AgentToRendererMessage[], reset?: boolean): void;
  }
}

const form = document.querySelector("form");
const status = document.querySelector("[role=status]");
const view = document.querySelector<A2uiSurface>("a2ui-surface");
if (!form || !status || !view) throw new Error("Missing demo controls");
let sessionId: string | undefined;
let busy = false;
let renderer: MessageProcessor<WebComponentImplementation>;

async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: {
    messages: AgentToRendererMessage[];
    sessionId?: string;
    error?: string;
  } = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Fixture request failed");
  return data;
}

const resetRenderer = () => {
  renderer?.dispose();
  window.lastA2uiAction = undefined;
  renderer = new MessageProcessor<WebComponentImplementation>(
    [basicCatalog],
    async (action) => {
      const message: ActionMessage = { version: "1.0", action };
      window.lastA2uiAction = message;
      if (!sessionId || busy) return;
      busy = true;
      try {
        const result = await post(`/action/${sessionId}`, message);
        window.replayA2ui(result.messages);
        status.textContent = "Action applied";
      } catch (error) {
        status.textContent = (error as Error).message;
      } finally {
        busy = false;
      }
    },
    { version: "1.0" },
  );
};

window.replayA2ui = (messages, reset) => {
  if (reset) resetRenderer();
  renderer.processMessages(messages);
  view.surface = renderer.getSurface("spike");
};

resetRenderer();
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await post("/show", values);
    sessionId = result.sessionId;
    window.replayA2ui(result.messages, true);
    status.textContent = "Fixture rendered";
  } catch (error) {
    status.textContent = (error as Error).message;
  } finally {
    busy = false;
  }
});
