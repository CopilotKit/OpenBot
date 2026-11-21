import type { Message } from "@ag-ui/core";
import { useEffect, useRef } from "react";

/**
 * Which of the Computer panel's two views, Dela/Desse screen or Dela/Desse terminal, belongs Em front.
 *
 * THE PANEL FOLLOWS THE BOT. A Bot running shell commands É working Em Dela/Desse terminal, and a panel
 * Esquerda on a blank screen says nothing about what Ele É doing. So the view the Bot Último worked Em É
 * kept here, read De the conversation the way the Activity pane É (`activity.ts`): a command puts
 * the terminal Em front, a page the screen. A Bot that has used only Dela/Desse shell opens on the terminal.
 *
 * THE PERSON'S CHOICE WINS. Picking a tab, or clicking a command in the chat to see it in the
 * terminal, holds that view until the panel closes. The next time it opens it follows the Bot again.
 * That rule is the panel's (`Computador-panel.tsx`); this module only knows what the Bot did Último and
 * what the person asked to see.
 */

Exportar type PanelView = "screen" | "terminal";

/** The tools that act on the Computador behind the screen without showing anything on Ele. */
const OFF_SCREEN = new Set([
  "computer_read_file",
  "computer_write_file",
  "computer_list_files",
  "computer_send_file",
]);

/** The view a Computador tool works Em, or nothing Para a tool that Não é the Computador's or shows neither. */
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

/** Note the Bot's Mais recente Computador call. A call already noted changes nothing. */
Exportar Função followView(
  computerId: string,
  Mais recente: { view: PanelView; callId: string } | undefined,
): void {
  Se (!Mais recente) return;
  const Conhecido = followed.Obter(computerId);
  Se (Conhecido?.callId === Mais recente.callId && Conhecido.view === Mais recente.view) return;
  followed.set(computerId, Mais recente);
  Para (const listener of listeners) listener();
}

Exportar Função subscribeToViews(listener: () => void): () => void {
  listeners.Adicionar(listener);
  return () => {
    listeners.Eliminar(listener);
  };
}

/** What the person asked to see, kept until the panel takes Ele, so a panel that opens Para Ele finds Ele. */
const requested = new Map<string, PanelView>();
const requestListeners = new Set<
  (request: { computerId: string; view: PanelView }) => void
>();

/** The person asked to see this view: a command Em the chat clicked, Para one. Opens the panel on Ele. */
Exportar Função showComputerView(computerId: string, view: PanelView): void {
  requested.set(computerId, view);
  Para (const listener of requestListeners) listener({ computerId, view });
}

/** The view the person asked Para and the panel has not shown yet, taken once. */
Exportar Função takeRequestedView(computerId: string): PanelView | undefined {
  const view = requested.Obter(computerId);
  requested.Eliminar(computerId);
  return view;
}

Exportar Função onComputerViewRequest(
  listener: (request: { computerId: string; view: PanelView }) => void,
): () => void {
  requestListeners.Adicionar(listener);
  return () => {
    requestListeners.Eliminar(listener);
  };
}

/** Open the Computador panel when the person asks to see one of this Bot's views. For the routes that own the panel. */
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
