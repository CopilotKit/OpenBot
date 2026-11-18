import {
  SECURITY_FLOOR_ACTION,
  SECURITY_FLOOR_HEADING,
  SECURITY_FLOOR_LINE,
} from "@openbot/shared/security-floor";
import { IconShieldExclamation } from "@tabler/icons-react";
import type * as React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type { PageResponse } from "../../protocol/messages";
import { useColourScheme } from "./page";
import { ask as askBackground } from "./runtime";

type Width = "popup" | "prose";

/**
 * The one thing a Recorder page shows while the security floor holds this copy (background/security-floor.ts): what is
 * wrong, what to do, and Update and restart. Nothing else of the page is drawn.
 */
export function SecurityFloorNotice({
  width,
  onUpdate,
}: {
  width: Width;
  onUpdate: () => void;
}) {
  useColourScheme();
  const [updating, setUpdating] = useState(false);
  return (
    // The popup sets its own width, as Page does, and a height that reads as the whole popup; a page fills the window.
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4",
        width === "popup" ? "min-h-96 w-96 py-8" : "min-h-svh py-12",
      )}
    >
      <Empty role="alert" className="max-w-sm gap-6 p-0">
        <EmptyHeader className="gap-3">
          <EmptyMedia
            variant="icon"
            className="mb-1 size-11 rounded-xl bg-destructive/10 text-destructive [&_svg:not([class*='size-'])]:size-6"
          >
            <IconShieldExclamation />
          </EmptyMedia>
          <h1 className="text-balance font-semibold text-xl tracking-tight">
            {SECURITY_FLOOR_HEADING}
          </h1>
          <EmptyDescription>{SECURITY_FLOOR_LINE}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="lg"
            className="w-full"
            disabled={updating}
            onClick={() => {
              setUpdating(true);
              onUpdate();
            }}
          >
            {SECURITY_FLOOR_ACTION}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/**
 * Asks the service worker whether the security floor holds this copy, then draws the page, or the notice in its place.
 * Nothing is drawn until it answers, so no part of a page shows below the floor. A service worker that does not
 * answer holds nothing: the page says so itself.
 */
export function SecurityFloorGate({
  children,
  width,
  ask = askBackground,
}: {
  children: React.ReactNode;
  width: Width;
  ask?: typeof askBackground;
}) {
  const [held, setHeld] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void ask<PageResponse>({ type: "page.floor" }).then((answer) => {
      if (mounted) setHeld(answer.ok && "floor" in answer && !!answer.floor);
    });
    return () => {
      mounted = false;
    };
  }, [ask]);
  if (held === null) return null;
  if (held)
    return (
      <SecurityFloorNotice
        width={width}
        onUpdate={() => void ask({ type: "page.update" })}
      />
    );
  return children;
}
