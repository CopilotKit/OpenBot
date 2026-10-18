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

/** The collector's navigation event, for a commit or a history update in any frame. */
export function navigationEvent(
  details: NavigationDetails,
  kind: NavigationKind,
  fromUrl: string | undefined,
): CapturedEvent {
  return {
    type: "CUSTOM",
    name: "navigation",
    timestamp: details.timeStamp ?? Date.now(),
    value: {
      from: fromUrl === undefined ? "" : scrubUrl(fromUrl),
      to: scrubUrl(details.url),
      navigationType: navigationType(details, kind),
      frameId: details.frameId,
      parentFrameId: details.parentFrameId ?? (details.frameId === 0 ? -1 : 0),
    },
  };
}
