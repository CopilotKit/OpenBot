import { useSyncExternalStore } from "react";
import type { VisibleChatItem } from "@/components/channels/chat-messages";
import { stepDetailsIn } from "@/components/channels/tool-activity";
import { asText } from "@/lib/plugins/tool-result";

/*
 * What a task used and what it made, read from its own thread: the web pages it read, the apps it
 * looked in, and the changes it made in them, as its Details pane lists them (dots' Sources and
 * Outputs). Nothing new is asked of the server: every step is already in the thread, with the
 * line the server put on each app call's answer saying whether the app changed anything ("Ran: read
 * only, nothing was changed." or "Ran: the app made this change.").
 *
 * The transcript works this out as it draws the thread, and hands it to the pane beside it through
 * a small store, so the pane never reads the conversation a second time.
 */

/** A page the task read. */
export type SourcePage = { kind: "page"; href: string; title?: string };
/** An app the task looked in. */
export type SourceApp = { kind: "app"; app: string };
export type Source = SourcePage | SourceApp;

/** Something the task made or changed, and where it can be opened when the app said. */
export type Output = { label: string; app?: string; href?: string };

export type ThreadWork = {
  sources: Source[];
  outputs: Output[];
  /** Whether it worked on the Bot's computer: a page opened in its browser. */
  usedComputer: boolean;
};

export const NO_THREAD_WORK: ThreadWork = {
  sources: [],
  outputs: [],
  usedComputer: false,
};

/** The first web address in an app's answer: where the thing it made can be opened. */
function firstLink(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'<>)\]]+/)?.[0]?.replace(/[.,;]+$/, "");
}

/** Whether an app's answer says it changed something. Its server says so on the first line. */
function changedSomething(text: string): boolean {
  return (
    /^(?:Partly ran|Already done):/.test(text) ||
    (/^Ran:/.test(text) && !/^Ran: read only/.test(text))
  );
}

/** The sources and outputs in a thread's items, each once, in the order the task met them. */
export function threadWorkOf(items: readonly VisibleChatItem[]): ThreadWork {
  const details = stepDetailsIn(new Map());
  const sources: Source[] = [];
  const outputs: Output[] = [];
  const pages = new Set<string>();
  const apps = new Set<string>();
  const made = new Set<string>();
  let usedComputer = false;
  const page = (href: string | undefined, title?: string) => {
    if (!href || !/^https?:\/\//.test(href) || pages.has(href)) return;
    pages.add(href);
    sources.push({ kind: "page", href, ...(title ? { title } : {}) });
  };
  for (const item of items) {
    if (item.kind !== "tool" || item.result === undefined) continue;
    const step = details(item);
    if (step.failed || step.refused || step.pending) continue;
    if (step.kind === "browser") {
      usedComputer = true;
      page(step.href, step.detail);
      continue;
    }
    if (step.kind === "search" || step.kind === "fetch") {
      for (const found of step.sources ?? []) page(found.url, found.title);
      if (!step.sources?.length) page(step.href);
      continue;
    }
    if (step.kind !== "connector" || !step.connector) continue;
    const answer = asText(item.result);
    if (changedSomething(answer)) {
      const href = firstLink(answer);
      const key = href ?? `${step.connector}\n${step.label}\n${step.detail}`;
      if (made.has(key)) continue;
      made.add(key);
      outputs.push({
        label: step.detail ? `${step.label} ${step.detail}` : step.label,
        app: step.connector,
        ...(href ? { href } : {}),
      });
    } else if (!apps.has(step.connector)) {
      apps.add(step.connector);
      sources.push({ kind: "app", app: step.connector });
    }
  }
  return { sources, outputs, usedComputer };
}

/* The store: the transcript publishes each thread's work, the Details pane reads it. */
const work = new Map<string, ThreadWork>();
const listeners = new Set<() => void>();

function same(a: ThreadWork | undefined, b: ThreadWork): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Say what a thread's task used and made, as its transcript reads it now. */
export function publishThreadWork(threadId: string, next: ThreadWork): void {
  if (same(work.get(threadId), next)) return;
  work.set(threadId, next);
  for (const listener of listeners) listener();
}

/** What a thread's task used and made, kept current while its transcript is drawn. */
export function useThreadWork(threadId: string | undefined): ThreadWork {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (threadId ? (work.get(threadId) ?? NO_THREAD_WORK) : NO_THREAD_WORK),
  );
}
