import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * One tool of an app, which in the team edition is under Admin. The personal edition gives every
 * Bot every tool, so there is nothing to choose one tool at a time: this opens the app's own page.
 */
export const Route = createFileRoute(
  "/_authed/_app/connections/$key_/tools/$tool",
)({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/connections/$key", params: { key: params.key } });
  },
});
