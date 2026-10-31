import type { PageResponse, PageToBackground } from "../../protocol/messages";

const NOT_ANSWERING: PageResponse = {
  ok: false,
  error: "The Recorder is not answering. Try again.",
};

/**
 * Sends one page message to the service worker's router and resolves its answer. A missing receiver
 * (chrome.runtime.lastError, a closed worker, a listener that never answers) becomes a refusal, never a throw.
 */
export function ask<T extends PageResponse>(
  message: PageToBackground,
): Promise<T> {
  return new Promise<T>((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response?: T) => {
        if (chrome.runtime.lastError || response === undefined) {
          resolve(NOT_ANSWERING as T);
          return;
        }
        resolve(response);
      });
    } catch {
      resolve(NOT_ANSWERING as T);
    }
  });
}
