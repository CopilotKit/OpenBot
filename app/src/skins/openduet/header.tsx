import { IconChevronLeft } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import type { AIState } from "@/components/agents/orb/ai-core";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ChannelWork,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { useNavigationItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { IconMenuShort } from "./icons";
import { DISC, FOCUS } from "./kit";
import {
  EDITOR_SELECTOR,
  pressOrb,
  pressOrbWhenReady,
  useComposerPresence,
} from "./orb-dictation";

/** The header's side discs: 46px, past the 44px a finger needs. */
const SIDE = 46;
/** The orb's footprint on a tab. */
const ORB = 62;

/** The person's initial, from their name, or their email when they have none. */
export function initialOf(user: { name?: string | null; email: string }) {
  const source = user.name?.trim() || user.email;
  return (source.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}

/**
 * What the open conversation is doing, from the roster OpenBot keeps live over its socket: a turn
 * running, or work it waits on between turns.
 */
function useOpenConversation() {
  const channelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const roster = useInfiniteQuery({
    ...channelListQueryOptions(),
    enabled: channelId !== undefined,
  });
  const channel = channelId
    ? roster.data?.find((row) => row.id === channelId)
    : undefined;
  const work: ChannelWork[] = channel?.work ?? [];
  return { busy: (channel?.busy ?? false) || work.length > 0, work };
}

/** What the Bot is doing, in a few words, for the pill under the orb. */
export function doingLine(busy: boolean, work: ChannelWork[]): string | null {
  const first = work[0];
  if (first?.kind === "handoff")
    return `Asking ${first.botName ?? "another Bot"}`;
  if (first?.kind === "routine") return "Running a routine";
  return busy ? "Thinking" : null;
}

/**
 * OpenDuet's header on a tab: the menu in a disc on the left, an orb in the centre, the person's
 * initial in a disc on the right (their settings). The orb is OpenBot's own (`AgentOrb`, as sign-in
 * and onboarding draw it), so the frame carries the deployment's identity, not OpenDuet's. It is the
 * way to talk: pressed, it
 * starts the composer's own dictation, or, on a screen with no composer, opens Chat and starts it
 * there. It looks down while the person types or talks, and thinks while the Bot works, with a pill
 * under it saying what the Bot is doing.
 *
 * `floating` lays it over a screen that scrolls under it, behind a fade. Otherwise it is a bar in
 * the column's flow, over an OpenBot page that owns its own scroller.
 */
export function TabHeader({
  floating,
  menuOpen,
  onMenu,
  main,
}: {
  floating: boolean;
  menuOpen: boolean;
  onMenu: () => void;
  /** The frame's content, where the composer the orb talks through is drawn. */
  main: HTMLElement | null;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  // Settings, from OpenBot's one navigation list, behind the person's initial.
  const settings = useNavigationItems().find((item) => item.id === "settings");
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const canDictate = capabilities.data?.transcription === true;
  const presence = useComposerPresence(main);
  const conversation = useOpenConversation();
  const navigate = useNavigate();
  const [goingToTalk, setGoingToTalk] = useState<(() => void) | null>(null);
  useEffect(() => () => goingToTalk?.(), [goingToTalk]);

  // Working is the composer's own Stop control or the roster's word for a run nobody here started.
  const working = presence.working || conversation.busy;
  const state: AIState = presence.recording
    ? "listening"
    : working
      ? "thinking"
      : presence.typing
        ? "listening"
        : "idle";

  const press = () => {
    if (!main) return;
    if (canDictate && pressOrb(main) !== "none") return;
    // A composer that cannot take dictation right now still takes typing.
    const editor = main.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (editor) {
      editor.focus();
      return;
    }
    void navigate({ to: "/" }).then(() => {
      if (canDictate) setGoingToTalk(() => pressOrbWhenReady(() => main));
    });
  };

  const label = !canDictate
    ? "Chat"
    : presence.recording
      ? "Stop and add to your message"
      : `Talk to ${appConfig.brand.productName}`;

  return (
    <header
      className={cn(
        "z-20 flex items-start justify-between px-4 pt-3",
        floating
          ? "pointer-events-none absolute inset-x-0 top-0 h-32 bg-(image:--openduet-fade)"
          : "relative h-[84px] shrink-0 bg-openduet-surface",
      )}
    >
      <button
        aria-expanded={menuOpen}
        aria-label="Menu"
        className={cn(DISC, "pointer-events-auto mt-2")}
        onClick={onMenu}
        style={{ width: SIDE, height: SIDE }}
        type="button"
      >
        <IconMenuShort size={21} stroke={1.8} />
      </button>
      {/* The span between the discs, so the pill under the orb never reaches under either. */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1 px-2">
        <button
          aria-label={label}
          aria-pressed={canDictate ? presence.recording : undefined}
          className={cn(
            "pointer-events-auto grid shrink-0 place-items-center rounded-full transition-transform active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100",
            FOCUS,
          )}
          onClick={press}
          style={{ width: ORB, height: ORB }}
          title={label}
          type="button"
        >
          <AgentOrb size={`${ORB - 6}px`} state={state} />
        </button>
        <DoingPill line={doingLine(working, conversation.work)} />
      </div>
      <Link
        aria-label="Your settings"
        to={settings?.to ?? "/settings"}
        className={cn(DISC, "pointer-events-auto mt-2")}
        style={{ width: SIDE, height: SIDE }}
      >
        <span className="openduet-type-nav font-semibold">
          {user ? initialOf(user) : null}
        </span>
      </Link>
    </header>
  );
}

/**
 * What the Bot is doing, in a glass pill under the orb. Always mounted, so the live region is there
 * before the first words arrive and it can fade out as well as in.
 */
function DoingPill({ line }: { line: string | null }) {
  const [held, setHeld] = useState(line);
  if (line !== null && line !== held) setHeld(line);
  const shown = line !== null;
  return (
    <div aria-live="polite" className="flex h-6 max-w-full justify-center">
      <p
        aria-hidden={shown ? undefined : true}
        className="openduet-glass openduet-type-caption flex h-6 max-w-full items-center rounded-full px-2.5 font-semibold text-openduet-ink shadow-openduet-glass transition-opacity duration-200 data-[shown=false]:opacity-0 motion-reduce:transition-none"
        data-shown={shown}
      >
        <span className="tool-line-running truncate">{held}</span>
      </p>
    </div>
  );
}

/** What a page drawn under the chrome says about itself. */
export type PageFacts = {
  /** The page's own title, from its `page-title` hook. */
  title: string | null;
  /** Where the page's own back link goes, and what it calls it, when the page has one. */
  back: { href: string; label: string } | null;
};

/**
 * Read the page's title and its own back link, for the chrome to show in their place. Only read:
 * the page is OpenBot's, rendered by React, and nothing here writes to it. The back link sits in the
 * bar `PageShell` draws above the scroller that holds the page's header.
 */
export function readPageFacts(root: ParentNode): PageFacts {
  const header = root.querySelector('[data-slot="page-header"]');
  const title =
    root.querySelector('[data-slot="page-title"]')?.textContent?.trim() || null;
  const bar = header?.parentElement?.parentElement?.previousElementSibling;
  const link = bar?.querySelector<HTMLAnchorElement>("a[href]");
  const href = link?.getAttribute("href");
  return {
    title,
    back: href ? { href, label: link?.textContent?.trim() ?? "" } : null,
  };
}

function usePageFacts(root: HTMLElement | null): PageFacts {
  const [facts, setFacts] = useState<PageFacts>({ title: null, back: null });
  useEffect(() => {
    if (!root) return;
    const read = () =>
      setFacts((before) => {
        const now = readPageFacts(root);
        return now.title === before.title &&
          now.back?.href === before.back?.href &&
          now.back?.label === before.back?.label
          ? before
          : now;
      });
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [root]);
  return facts;
}

/**
 * The chrome for a page opened over the app: a back disc on the left, the page's title in a glass
 * pill in the middle, and nothing on the right. No menu, no avatar and no tab bar, so a page reads
 * as somewhere you came to and go back from. Back goes where the page's own back link goes when it
 * has one (a Bot's page goes to Bots), back through history otherwise, and to Chat with neither.
 */
export function PageHeader({ main }: { main: HTMLElement | null }) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { title, back } = usePageFacts(main);
  return (
    <header className="relative z-20 flex h-[72px] shrink-0 items-start gap-2 px-4 pt-3">
      <button
        aria-label={back?.label ? `Back to ${back.label}` : "Back"}
        className={DISC}
        onClick={() => {
          if (back) void router.navigate({ href: back.href });
          else if (canGoBack) router.history.back();
          else void router.navigate({ to: "/" });
        }}
        style={{ width: SIDE, height: SIDE }}
        type="button"
      >
        <IconChevronLeft size={22} stroke={1.8} />
      </button>
      <div className="flex min-w-0 flex-1 justify-center">
        {title ? (
          <div className="openduet-glass flex h-[46px] min-w-0 max-w-full items-center justify-center rounded-full px-4 shadow-openduet-glass">
            {/* The page's own title stays for screen readers; this is what the eye reads. */}
            <p
              aria-hidden
              className="openduet-type-sub max-w-full truncate font-semibold text-openduet-ink"
            >
              {title}
            </p>
          </div>
        ) : null}
      </div>
      <span aria-hidden className="shrink-0" style={{ width: SIDE }} />
    </header>
  );
}
