/**
 * A conversation, live, on the phone: ./live-thread.ts with the app's own API, sign-in and React Native's WebSocket.
 */
import { AppState } from "react-native";
import { ORGANIZATION_ID } from "./api";
import { createConversationJoinToken } from "./api/generated/conversations/conversations";
import { authClient, serverUrl } from "./auth";
import {
  type LiveHandlers,
  type LiveSocket,
  watchConversation,
} from "./live-thread";
import { clientHeaders } from "./release";

/** React Native's WebSocket takes headers as a third argument: how the access token reaches the upgrade. */
const NativeSocket = WebSocket as unknown as new (
  url: string,
  protocols: null,
  options: { headers: Record<string, string> },
) => LiveSocket;

export function watchConversationLive(
  conversationId: string,
  handlers: LiveHandlers,
) {
  return watchConversation(conversationId, handlers, {
    joinToken: (id) => createConversationJoinToken(ORGANIZATION_ID, id),
    open: (url, headers) => new NativeSocket(url, null, { headers }),
    accessToken: () => authClient.getAccessToken(),
    clientHeaders,
    server: serverUrl,
    inFront: () => AppState.currentState === "active",
    onInFront(listener) {
      const subscription = AppState.addEventListener("change", (state) =>
        listener(state === "active"),
      );
      return () => subscription.remove();
    },
  });
}
