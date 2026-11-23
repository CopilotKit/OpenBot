import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryClient } from "@/query-client";
import {
  type AssistantLayout,
  assistantLayoutQueryOptions,
  desktopKeys,
} from "./queries";
import { desktopShell } from "./shell";

/**
 * What the desktop app dispatches on the page when compact view's window changes shape without the
 * page asking: Close Window folds the panel, and so does Open full window (`LAYOUT_EVENT` in
 * desktop/src-tauri/src/assistant.rs). Its `detail` is the new layout.
 */
export const ASSISTANT_LAYOUT_EVENT = "openbot:assistant-layout";

/** Outside OpenBot Desktop there is no bubble: the page is the panel, filling the tab. */
const IN_A_BROWSER: AssistantLayout = {
  expanded: true,
  corner: "bottom-right",
};

/**
 * Whether compact view's window shows the bubble or the panel, and which corner the panel opened
 * from. Undefined until the desktop app has answered, which takes one local round trip.
 */
export function useAssistantLayout(): AssistantLayout | undefined {
  const inDesktop = desktopShell() !== null;
  const layout = useQuery(assistantLayoutQueryOptions());
  useEffect(() => {
    const told = (event: Event) => {
      const detail = (event as CustomEvent<AssistantLayout | undefined>).detail;
      if (detail) queryClient.setQueryData(desktopKeys.assistantLayout, detail);
    };
    window.addEventListener(ASSISTANT_LAYOUT_EVENT, told);
    return () => window.removeEventListener(ASSISTANT_LAYOUT_EVENT, told);
  }, []);
  return inDesktop ? layout.data : IN_A_BROWSER;
}

/**
 * Move compact view's window with the pointer, from a press that is still held: the system drags it
 * from here until the button is let go. The page is granted this one window command
 * (`allow_app_page` in desktop/src-tauri/src/main.rs).
 */
export function dragWindow(): void {
  desktopShell()
    ?.invoke("plugin:window|start_dragging")
    .catch(() => {});
}
