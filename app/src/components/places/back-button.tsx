import { IconChevronLeft } from "@tabler/icons-react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePlacesEnabled } from "@/lib/places/store";
import { cn } from "@/lib/utils";

/**
 * The one Back button, drawn in the page bar while places are on. It goes back through history, so
 * it returns to the page you were on, and it is inert on the first page of a visit.
 */
export function BackButton({ className }: { className?: string }) {
  const placesOn = usePlacesEnabled();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  if (!placesOn) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Back"
            className={cn("text-muted-foreground", className)}
            disabled={!canGoBack}
            onClick={() => router.history.back()}
            size="icon"
            variant="ghost"
          >
            <IconChevronLeft className="size-4.5" />
          </Button>
        }
      />
      <TooltipContent side="bottom">Back</TooltipContent>
    </Tooltip>
  );
}
