import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { directoryRouteDecision } from "@/lib/plugins/provider-vocabulary";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Composio's directory, searched rather than listed.
 *
 * The screen itself is `components/plugins/broker-directory.tsx`, which draws whichever broker is
 * active and reads every vendor word from the vocabulary. This file is the guard and the delegation,
 * and nothing else: the sibling route is its mirror, and a route file importing another route file
 * is how two screens that should be one begin to drift.
 *
 * Adding an app is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable — which is
 * made on their settings page, not here.
 */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: RouteComponent,
});

/**
 * The route guard: this directory answers only on a Composio deployment.
 *
 * A route answering for the wrong provider is how a Composio-shaped enablement flow gets spent
 * against an Arcade project. Nothing is drawn, and so no directory request is made, until the page
 * has said which provider this is.
 */
function RouteComponent() {
  const plugins = useQuery(pluginsPageQueryOptions());
  /*
   * `data` stays undefined PERMANENTLY on a failed read, not only while loading, so the gate below
   * would answer "pending" forever and draw a blank page. A failure is said, and the directory is
   * not drawn: it would fire a request against a provider nobody has confirmed.
   */
  if (plugins.isError) {
    return (
      <p className="m-4 text-destructive text-sm" role="alert">
        Couldn't load the plugin settings. Reload the page.
      </p>
    );
  }
  const decision = directoryRouteDecision("composio", plugins.data);
  if (decision === "redirect") return <Navigate replace to="/admin/plugins" />;
  if (decision === "pending") return null;
  return <BrokerDirectory provider="composio" />;
}
