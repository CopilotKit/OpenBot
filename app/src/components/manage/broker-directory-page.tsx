import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import {
  BrokerDirectory,
  type DirectoryPlace,
} from "@/components/plugins/broker-directory";
import { appSetupQueryOptions } from "@/lib/apps/queries";
import { loadFailure } from "@/lib/load-failure";
import {
  type BrokerDirectory as Broker,
  useManagePaths,
} from "@/lib/manage-paths";
import { directoryRouteDecision } from "@/lib/plugins/provider-vocabulary";

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
export function BrokerDirectoryPage({
  provider,
  place = "admin",
}: {
  provider: Broker;
  /** Opened from Connections, where a press connects or asks; or from Admin, where it adds. */
  place?: DirectoryPlace;
}) {
  const paths = useManagePaths();
  const setup = useQuery(appSetupQueryOptions());
  /*
   * `data` stays undefined PERMANENTLY on a failed read, not only while loading, so the gate below
   * would answer "pending" forever and draw a blank page. A failure is said, and the directory is
   * not drawn: it would fire a request against a provider nobody has confirmed.
   */
  if (setup.isError) {
    return (
      <p className="m-4 text-destructive text-sm" role="alert">
        {loadFailure(
          setup.error,
          "Couldn't load the app settings. Try again in a moment.",
        )}
      </p>
    );
  }
  const decision = directoryRouteDecision(provider, setup.data);
  if (decision === "redirect")
    return place === "connections" ? (
      <Navigate replace to="/connections" />
    ) : (
      <Navigate replace {...paths.plugins()} />
    );
  if (decision === "pending") return null;
  return <BrokerDirectory place={place} provider={provider} />;
}
