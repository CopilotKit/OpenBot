import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/**
 * "OpenBot is AI and can make mistakes.", under the composer of every conversation, in the name this
 * OpenBot is configured with. Small and muted: it is there to be found, not to be read every time.
 */
export function AiNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "type-caption pt-2 text-center text-muted-foreground",
        className,
      )}
    >
      {appConfig.brand.productName} is AI and can make mistakes.
    </p>
  );
}
