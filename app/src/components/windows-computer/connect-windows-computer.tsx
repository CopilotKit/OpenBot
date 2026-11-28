import { IconDeviceDesktop, IconPlugConnected } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { PageEmpty } from "@/components/layout/page-shell";
import { copyText } from "@/components/settings/linked-accounts";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createWindowsComputerEnrollmentCodeMutationOptions } from "@/lib/windows-computer/mutations";
import type { WindowsComputer } from "@/lib/windows-computer/queries";

/** What the page says when no Windows computer is connected, in the person's words. */
export function connectWords(computer: Pick<WindowsComputer, "enrolled">): {
  title: string;
  description: string;
} {
  return computer.enrolled
    ? {
        title: "Your Windows computer isn't connected",
        description:
          "It connects to OpenBot by itself whenever it's on and you're signed in to it. If it was set up again, connect it with a new code.",
      }
    : {
        title: "Connect your Windows computer",
        description:
          "Make a code here, then give it to OpenBot on your Windows computer. It connects to OpenBot by itself from then on, so OpenBot never has to reach into your network.",
      };
}

/** The code's expiry, as the person reads it: a time of day. */
function until(expiresAt: string): string {
  return new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Connecting a Windows computer (`createWindowsComputerEnrollmentCode`): a one-time code, shown once, that OpenBot's
 * program on the Windows computer exchanges for its own credential. Shown where the Windows computer would be, while
 * none is connected; the page reads the computer again every few seconds and shows it once it connects.
 */
export function ConnectWindowsComputer({
  computer,
}: {
  computer: Pick<WindowsComputer, "enrolled">;
}) {
  const make = useMutation(
    createWindowsComputerEnrollmentCodeMutationOptions(),
  );
  const [copied, setCopied] = useState<boolean | null>(null);
  const words = connectWords(computer);
  const code = make.data;

  return (
    <PageEmpty
      action={
        <div className="flex w-full max-w-md flex-col items-center gap-4">
          {code ? (
            <Field className="w-full text-left">
              <FieldLabel htmlFor="windows-computer-code">Code</FieldLabel>
              <div className="flex gap-2">
                <Input
                  className="font-mono"
                  id="windows-computer-code"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={code.code}
                />
                <Button
                  onClick={async () =>
                    setCopied(await copyText(code.code, navigator.clipboard))
                  }
                  variant="outline"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <FieldDescription>
                {copied === false
                  ? "Couldn't copy it. Select the code and copy it yourself."
                  : `Works once, until ${until(code.expiresAt)}. It isn't shown again: if it runs out, make a new one.`}
              </FieldDescription>
            </Field>
          ) : null}
          <Button
            disabled={make.isPending}
            onClick={() => {
              setCopied(null);
              make.mutate();
            }}
            variant={code ? "outline" : "default"}
          >
            {make.isPending
              ? "Making a code…"
              : code
                ? "Make a new code"
                : "Make a code"}
          </Button>
          {make.error ? (
            <p className="text-destructive text-sm" role="alert">
              {make.error.message}
            </p>
          ) : null}
        </div>
      }
      icon={computer.enrolled ? IconDeviceDesktop : IconPlugConnected}
      title={words.title}
    >
      {words.description}
    </PageEmpty>
  );
}
