import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { UpdateBanner } from "@/components/layout/update-banner";
import { type DesktopAppUpdate, desktopKeys } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";

/**
 * The update banner over the page it sits on, at the width of OpenBot's content column, as a page
 * of its own for update-banner-layout.test.tsx to bundle and load in Chromium. The desktop app is
 * the IPC Tauri injects (`__TAURI_INTERNALS__`), answering `update_offer` with `window.__offer`;
 * `window.__show(offer)` changes that answer and has the banner ask again, as its poll does.
 *
 * `?width=<px>` is the column's width.
 */
type Page = Window & {
  __offer: DesktopAppUpdate;
  __show: (offer: DesktopAppUpdate) => Promise<void>;
  __TAURI_INTERNALS__: unknown;
};
const page = window as unknown as Page;
const width = Number(new URLSearchParams(location.search).get("width") ?? 650);

page.__offer = {
  version: null,
  current: "1.0.0",
  installing: null,
  updatesItself: true,
  ready: null,
};
page.__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (command === "plugin:openbot-desktop|update_offer") return page.__offer;
    throw `command ${command} not found`;
  },
  transformCallback: () => 0,
};
page.__show = async (offer) => {
  page.__offer = offer;
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
};

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-svh flex-col bg-background" style={{ width }}>
        <UpdateBanner />
        <h1 className="p-4 font-semibold text-2xl" data-below="">
          Start a conversation
        </h1>
      </div>
    </QueryClientProvider>,
  );
