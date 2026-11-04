import { createFileRoute, redirect } from "@tanstack/react-router";
import { personalAppsAddress } from "@/lib/manage-paths";

/** Apps were here before they joined Connections. An old address opens the same page there. */
export const Route = createFileRoute("/_authed/settings/_personal/plugins/$")({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: personalAppsAddress(params._splat ?? ""),
      replace: true,
    });
  },
});
