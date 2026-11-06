import type { Message } from "@ag-ui/core";
import { useEffect, useRef } from "react";

/**
 * Which of the Computer panel's two views, its screen or its terminal, belongs in front.
 *
 * THE PANEL FOLLOWS THE BOT. A Bot running shell commands is working in its terminal, and a panel
 * left on a blank screen says nothing about what it is doing. So the view the Bot last worked in is
 * kept here, read from the conversation the way the Activity pane is (`activity.ts`): a command puts
 * the terminal in front, a page the screen. A Bot that has used only its shell opens on the terminal.
 *
 * THE PERSON'S CHOICE WINS. Picking a tab, or clicking a command in the chat to see it in the
 * terminal, holds that view until the panel closes. The next time it opens it follows the Bot again.
 * That rule is the panel's (`computer-panel.tsx`); this module only knows what the Bot did last and
 * what the person asked to see.
 */

export type PanelView = "screen" | "terminal";

/** The tools that act on the computer behind the screen without showing anything on it. */
const OFF_SCREEN = new Set([
  "computer_read_file",
  "computer_write_file",
  "computer_list_files",
]);

/** The view a computer tool works in, or nothing for a tool that is not the computer's or shows neither. */
export function viewOfTool(name: string): PanelView | undefined {
  if (name === "computer_run_command") return "terminal";
  if (!name.startsWith("computer_") || OFF_SCREEN.has(name)) return undefined;
  return "screen";
}

/** The view of the last computer call in a conversation, and that call, so a change can be told from a repeat. */
export function latestView(
  messages: readonly Message[],
): { view: PanelView; callId: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const calls = message.toolCalls ?? [];
    for (let call = calls.length - 1; call >= 0; call -= 1) {
      const toolCall = calls[call];
      if (!toolCall) continue;
      const view = viewOfTool(toolCall.function.name);
      if (view) return { view, callId: toolCall.id };
    }
  }
  return undefined;
}

const followed = new Map<string, { view: PanelView; callId: string }>();
const listeners = new Set<() => void>();

/** The view the Bot last worked in on this computer, as the conversation says. */
export function followedView(computerId: string): PanelView | undefined {
  return followed.get(computerId)?.view;
}

/** Note the Bot's latest computer call. A call already noted changes nothing. */
export function followView(
  computerId: string,
  latest: { view: PanelView; callId: string } | undefined,
): void {
  if (!latest) return;
  const known = followed.get(computerId);
  if (known?.callId === latest.callId && known.view === latest.view) return;
  followed.set(computerId, latest);
  for (const listener of listeners) listener();
}

export function subscribeToViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What the person asked to see, kept until the panel takes it, so a panel that opens for it finds it. */
const requested = new Map<string, PanelView>();
const requestListeners = new Set<
  (request: { computerId: string; view: PanelView }) => void
>();

/** The person asked to see this view: a command in the chat clicked, for one. Opens the panel on it. */
export function showComputerView(computerId: string, view: PanelView): void {
  requested.set(computerId, view);
  for (const listener of requestListeners) listener({ computerId, view });
}

/** The view the person asked for and the panel has not shown yet, taken once. */
export function takeRequestedView(computerId: string): PanelView | undefined {
  const view = requested.get(computerId);
  requested.delete(computerId);
  return view;
}

export function onComputerViewRequest(
  listener: (request: { computerId: string; view: PanelView }) => void,
): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** Open the Computer panel when the person asks to see one of this Bot's views. For the routes that own the panel. */
export function useOpenComputerOnRequest(
  computerId: string | undefined,
  open: () => void,
): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!computerId) return;
    return onComputerViewRequest((request) => {
      if (request.computerId === computerId) latest.current();
    });
  }, [computerId]);
}
