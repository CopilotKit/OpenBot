import { useState } from "react";
import { copyText } from "@/components/settings/linked-accounts";
import { Button } from "@/components/ui/button";

/**
 * A Copy button that says whether the text landed on the clipboard: Copied when it did, and a line
 * under it when the browser refused, so the person copies it themselves.
 */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        aria-label={label}
        onClick={async () =>
          setCopied(await copyText(text, navigator.clipboard))
        }
        size="sm"
        type="button"
        variant="outline"
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {copied === false ? (
        <span className="text-destructive text-xs" role="alert">
          Couldn't copy. Select it and copy it yourself.
        </span>
      ) : null}
    </div>
  );
}
