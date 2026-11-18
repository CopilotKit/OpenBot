import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BotKite } from "@/components/agents/kite/bot-kite";
import { StaggerItem } from "@/components/layout/stagger";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { relativeTimeShort } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { type KiteBot, kiteBots, skyLine, skyOrder } from "./roster";

/** Two rows of four on a wide screen, two of two on a phone. The rest are one "All Bots" away. */
const SKY_SHOWN = 8;

function ago(iso: string): string {
  const short = relativeTimeShort(iso);
  return short === "now" ? "just now" : `${short} ago`;
}

/**
 * The Sky: Kite Bot's home under the composer, in place of OpenBot's Explore Bots. Every Bot's kite,
 * with what needs you first, then what is working, then whoever was busiest last. A kite wakes when
 * you point at it or tab to it, and choosing one opens its newest conversation, or starts one.
 *
 * Every state holds the same two rows, so the composer above never moves when the Bots arrive.
 */
export function KiteSky() {
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const sky = skyOrder(
    kiteBots(bots.data ?? [], channels.data ?? [], attention.data ?? []),
  );
  const shown = sky.slice(0, SKY_SHOWN);

  return (
    <section
      aria-labelledby="kitebot-sky-heading"
      className="mt-12 w-full max-w-2xl"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2
          className="font-medium text-[13px] text-muted-foreground"
          id="kitebot-sky-heading"
        >
          Your Bots
        </h2>
        {sky.length > SKY_SHOWN ? (
          <Link
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            to="/bots"
          >
            All {sky.length}
          </Link>
        ) : null}
      </div>
      <ul className="mt-3 grid min-h-[196px] grid-cols-2 content-start gap-2 max-sm:[&>li:nth-child(n+5)]:hidden sm:grid-cols-4">
        {bots.isPending
          ? Array.from({ length: 4 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key on.
              <li key={index}>
                <Skeleton className="h-[94px] rounded-xl" />
              </li>
            ))
          : shown.map((one, index) => (
              <li className="min-w-0" key={one.bot.id}>
                <StaggerItem index={index}>
                  <SkyTile one={one} />
                </StaggerItem>
              </li>
            ))}
      </ul>
      {bots.isError && !bots.data ? (
        <p className="mt-2 text-[13px] text-destructive" role="alert">
          Couldn't load your Bots.
        </p>
      ) : null}
    </section>
  );
}

function SkyTile({ one }: { one: KiteBot }) {
  const [contact, setContact] = useState(false);
  const latest = one.conversations[0];
  const link = latest
    ? ({
        to: "/channel/$channelId",
        params: { channelId: latest.id },
      } as const)
    : ({ to: "/channel/new", search: { agent: one.bot.id } } as const);
  const line = skyLine(one, ago);
  return (
    <Link
      {...link}
      className={cn(
        "group flex h-[94px] flex-col justify-between rounded-xl border border-border bg-card p-3 outline-none transition-[border-color,box-shadow,transform] duration-200 ease-out hover:border-foreground/15 hover:shadow-[0_2px_10px_-4px_rgb(0_0_0/0.12)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985]",
        one.paused && "opacity-60",
      )}
      onBlur={() => setContact(false)}
      onFocus={() => setContact(true)}
      onPointerEnter={() => setContact(true)}
      onPointerLeave={() => setContact(false)}
    >
      <BotKite
        awake={contact && !one.paused}
        look={[0, 1]}
        name={one.bot.name}
        seed={one.bot.avatarSeed}
        size={30}
        state={one.paused ? "idle" : one.state}
      />
      <span className="min-w-0">
        <span className="block truncate font-medium text-[13px] text-foreground">
          {one.bot.name}
        </span>
        <span
          className={cn(
            "block truncate text-[12px] text-muted-foreground",
            one.waiting > 0 && "text-amber-700 dark:text-amber-300",
            one.state === "working" &&
              one.waiting === 0 &&
              "text-[#2f6fed] dark:text-[#6c9cff]",
          )}
        >
          {line}
        </span>
      </span>
    </Link>
  );
}
