import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import {
  type BrokerDirectory as Broker,
  useManagePaths,
} from "@/lib/manage-paths";
import { directoryRouteDecision } from "@/lib/plugins/provider-vocabulary";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * A broker's directory, searched rather than listed, behind its guard: it answers only on a
 * deployment running that broker.
 *
 * The screen itself is `components/plugins/broker-directory.tsx`, which draws whichever broker is
 * active and reads every vendor word from the vocabulary. This is the guard and the delegation, and
 * nothing else, shared by the Composio and Arcade routes under Admin and under Settings.
 *
 * A route answering for the wrong provider is how an enablement flow gets spent against the wrong
 * project. Nothing is drawn, and so no directory request is made, until the page has said which
 * provider this is.
 *
 * Adding an app is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable — which is
 * made on their settings page, not here.
 */
export function BrokerDirectoryPage({ provider }: { provider: Broker }) {
  const paths = useManagePaths();
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
  const decision = directoryRouteDecision(provider, plugins.data);
  if (decision === "redirect") return <Navigate replace {...paths.plugins()} />;
  if (decision === "pending") return null;
  return <BrokerDirectory provider={provider} />;
}
