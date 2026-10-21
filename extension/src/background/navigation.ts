import { type CapturedEvent, scrubUrl } from "@openbot/shared/recorder-masking";

export type NavigationDetails = {
  tabId: number;
  frameId: number;
  parentFrameId?: number;
  url: string;
  transitionType?: string;
  transitionQualifiers?: string[];
  timeStamp?: number;
};

type NavigationKind = "commit" | "history";
type NavigationType = "push" | "replace" | "traverse" | "reload";

function goesBackOrForward(details: NavigationDetails): boolean {
  return details.transitionQualifiers?.includes("forward_back") ?? false;
}

function navigationType(
  details: NavigationDetails,
  kind: NavigationKind,
): NavigationType {
  if (kind === "history") return "push";
  if (goesBackOrForward(details)) return "traverse";
  if (details.transitionType === "reload") return "reload";
  return "push";
}

/** The collector's navigation event, for a commit or a history update in any frame: `navigationType` in CopilotKit's
 * own words (push, replace, traverse, reload), and beside it how Chrome says the page was reached (webNavigation's
 * transitionType and transitionQualifiers: an address typed, a link, a form, a reload, a redirect). `options.digests`,
 * the recording's sensitive-value digests, mask a value typed into a sensitive field wherever an address holds it later. */
export function navigationEvent(
  details: NavigationDetails,
  kind: NavigationKind,
  fromUrl: string | undefined,
  options?: { digests?: ReadonlySet<string> },
): CapturedEvent {
  return {
    type: "CUSTOM",
    name: "navigation",
    timestamp: details.timeStamp ?? Date.now(),
    value: {
      from: fromUrl === undefined ? "" : scrubUrl(fromUrl, options),
      to: scrubUrl(details.url, options),
      navigationType: navigationType(details, kind),
      ...(details.transitionType
        ? { transitionType: details.transitionType }
        : {}),
      ...(details.transitionQualifiers
        ? { transitionQualifiers: [...details.transitionQualifiers] }
        : {}),
      frameId: details.frameId,
      parentFrameId: details.parentFrameId ?? (details.frameId === 0 ? -1 : 0),
    },
  };
}
