import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * What OpenBot runs on this computer is a section of Settings → Computer now.
 *
 * Keep this file: OpenBot Desktop opens this address, and only once it finds this file in the
 * checkout (`show_status_in_app` in desktop/src-tauri/src/main.rs).
 */
export const Route = createFileRoute("/_authed/settings/this-computer")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/computer", replace: true });
  },
});
