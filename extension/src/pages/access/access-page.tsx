import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { hasHostPermission } from "../../shared/host-access";
import { Page } from "../ui/page";

type Outcome = "checking" | "idle" | "asking" | "granted" | "denied" | "held";

const SENTENCE = {
  granted: "Done. Open the Recorder from the toolbar and press Record.",
  denied:
    "The Recorder needs access to websites to record them. Choose Allow access to websites to try again.",
  held: "The Recorder can already read websites.",
} as const;

/**
 * Asks for website access on a full tab, because Chrome's permission prompt can take focus and
 * close the popup before its promise settles. Purely functional: it asks for one permission.
 */
export function AccessPage() {
  const [outcome, setOutcome] = useState<Outcome>("checking");

  useEffect(() => {
    let live = true;
    hasHostPermission().then(
      (held) => live && setOutcome(held ? "held" : "idle"),
      () => live && setOutcome("idle"),
    );
    return () => {
      live = false;
    };
  }, []);

  const allow = async () => {
    setOutcome("asking");
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
    } catch {
      granted = false;
    }
    setOutcome(granted ? "granted" : "denied");
  };

  const asking =
    outcome === "idle" || outcome === "asking" || outcome === "denied";

  return (
    <Page
      title="Let the Recorder read websites"
      description="Chrome needs your permission before the Recorder can record what happens on a website. It asks once."
      width="prose"
    >
      {asking ? (
        <div className="mt-8 flex gap-2">
          <Button size="lg" disabled={outcome === "asking"} onClick={allow}>
            Allow access to websites
          </Button>
          <Button size="lg" variant="ghost" onClick={() => window.close()}>
            Not now
          </Button>
        </div>
      ) : null}
      {outcome === "granted" || outcome === "denied" || outcome === "held" ? (
        <p
          className={
            outcome === "denied"
              ? "mt-4 text-destructive text-sm"
              : "mt-4 text-sm"
          }
          role={outcome === "denied" ? "alert" : "status"}
        >
          {SENTENCE[outcome]}
        </p>
      ) : null}
    </Page>
  );
}
