import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { directoryRouteDecision } from "@/lib/plugins/provider-vocabulary";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Arcade's directory, searched rather than listed.
 *
 * The mirror of the sibling directory route, and deliberately nothing more. The screen itself is
 * `components/plugins/broker-directory.tsx`; the directory endpoint behind it is provider-blind and
 * answers from whichever broker this deployment runs, so this route adds a guard and a provider name
 * and no behaviour of its own.
 *
 * Until this existed the coverage warning and the consent-breadth line were drawn on no deployment
 * anybody runs: they live on a directory row, the only directory route redirected away on an Arcade
 * deployment, and Arcade is the only provider that publishes the counts they are computed from.
 */
export const Route = createFileRoute("/_authed/admin/plugins/arcade")({
  component: RouteComponent,
});

/**
 * The route guard: this directory answers only on an Arcade deployment.
 *
 * A route answering for the wrong provider is how an enablement flow gets spent against the wrong
 * project. Nothing is drawn, and so no directory request is made, until the page has said which
 * provider this is.
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
  const decision = directoryRouteDecision("arcade", plugins.data);
  if (decision === "redirect") return <Navigate replace to="/admin/plugins" />;
  if (decision === "pending") return null;
  return <BrokerDirectory provider="arcade" />;
}
