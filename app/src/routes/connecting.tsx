import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConsentHandoffPage } from "@/components/plugins/consent-handoff";
import {
  forgetConsentHandoff,
  readConsentHandoff,
} from "@/lib/plugins/consent-handoff";

/**
 * The step before an app's sign-in through Composio, in the tab the sign-in opened in. The tab that
 * opened it left what to show in this origin's storage, under the name after `#`; see
 * `storeConsentHandoff`. Not behind sign-in: it asks the API nothing, and a name nobody left here
 * shows that there is nothing to continue.
 */
export const Route = createFileRoute("/connecting")({
  component: function ConnectingRoute() {
    const [id] = useState(() =>
      decodeURIComponent(window.location.hash.replace(/^#/, "")),
    );
    const [handoff] = useState(() => (id ? readConsentHandoff(id) : null));
    return (
      <ConsentHandoffPage
        handoff={handoff}
        onContinue={(next) => {
          forgetConsentHandoff(id);
          window.location.replace(next.url);
        }}
      />
    );
  },
});
