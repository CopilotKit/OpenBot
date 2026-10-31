import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/**
 * "General Assistant is AI and can make mistakes.", under the composer of every conversation: the
 * Bot the person is talking to by its name, "These Bots…" for a conversation with several, and the
 * name this OpenBot is configured with until the Bots are known. Small and muted: it is there to be
 * found, not to be read every time.
 */
export function AiNotice({
  botNames = [],
  className,
}: {
  /** The names of the conversation's Bots. */
  botNames?: readonly string[];
  className?: string;
}) {
  const names = [...new Set(botNames.filter((name) => name.trim()))];
  const who =
    names.length === 1
      ? `${names[0]} is`
      : names.length > 1
        ? "These Bots are"
        : `${appConfig.brand.productName} is`;
  return (
    <p
      className={cn(
        "type-caption pt-2 text-center text-muted-foreground",
        className,
      )}
    >
      {who} AI and can make mistakes.
    </p>
  );
}
