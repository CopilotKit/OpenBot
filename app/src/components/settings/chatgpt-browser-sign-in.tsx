import {
  IconClipboard,
  IconExternalLink,
  IconMoodSad,
} from "@tabler/icons-react";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { IllustrationFrame } from "@/components/onboarding/illustration-frame";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * ChatGPT's sign-in in the browser, where the server runs it (a person's own AI on OpenBot Cloud).
 *
 * WHY IT LOOKS LIKE THIS. ChatGPT's sign-in is Codex's, and OpenAI lets it send the browser only to
 * `http://localhost:1455/auth/callback`, where Codex itself would be listening. Nothing listens
 * there for a browser on the web, so once the person approves, their browser shows its own "This
 * site can't be reached" page, and that page's address carries what finishes the sign-in. The
 * address can't be changed and nothing in OpenBot's tab can read the other tab, so the person
 * copies it back. Done with no warning, that reads as broken; these screens say it first.
 *
 * So it is the second way in. The first is ChatGPT's sign-in with a code (`ChatGptCodeSteps`),
 * which never shows a page that won't load but needs device code sign-in turned on in ChatGPT first.
 *
 * - Before it starts: three numbered steps and a drawing of the page they will land on, with its
 *   address marked as the thing to copy.
 * - While it waits: the paste box. Coming back to this tab puts the cursor in it. Pasting into it,
 *   or pressing Paste (the Clipboard API, where the browser allows it), finishes at once. Typing
 *   or pasting and pressing Finish always works.
 * - A paste of OpenAI's own sign-in page is caught here, before anything is sent, since it is the
 *   one wrong address people are most likely to copy. Anything else the server reads and refuses
 *   in its own words (an address from another sign-in, one with no code), and the box stays open.
 */

/** Where ChatGPT sends the browser once the person approves. Shown, never dialled. */
const LANDING = "localhost:1455/auth/callback?code=ac_…";

export const CHATGPT_DEAD_PAGE = "This site can't be reached";

/**
 * ChatGPT's own settings, opened on Security and login: where a person turns on device code
 * sign-in. The address OpenAI's help center links to (help.openai.com, article 7967234); OpenAI's
 * Codex docs say device code sign-in is turned on there for a personal account, and in workspace
 * permissions by the workspace's admin.
 */
export const CHATGPT_SECURITY_SETTINGS =
  "https://chatgpt.com/#settings/Security";

/** The link to ChatGPT's security settings, in the same style as the sign-in page's link. */
export function ChatGptSettingsLink({
  children = "Open ChatGPT's security settings",
}: {
  children?: React.ReactNode;
}) {
  return (
    <a
      className="text-foreground underline underline-offset-4"
      href={CHATGPT_SECURITY_SETTINGS}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <IconExternalLink className="ml-0.5 inline size-3.5" />
    </a>
  );
}

/**
 * ChatGPT's sign-in with a code, the first way in where the server runs it: the setting OpenAI asks
 * for first, with the link to it, then the code. It never lands on a page that won't load.
 */
export function ChatGptCodeSteps() {
  return (
    <ol className="flex flex-col gap-2.5 text-sm">
      <Step number={1}>
        <span className="flex flex-col gap-1">
          <span>
            Turn on device code sign-in in ChatGPT. Under Security and login,
            switch on “Enable device code sign-in”.
          </span>
          <span>
            <ChatGptSettingsLink />
          </span>
          <span className="text-muted-foreground">
            On a Team or Enterprise workspace, your ChatGPT workspace admin
            turns it on.
          </span>
        </span>
      </Step>
      <Step number={2}>Sign in with ChatGPT below to get a code.</Step>
      <Step number={3}>
        Enter the code on OpenAI's page and approve. It finishes on its own.
      </Step>
    </ol>
  );
}

/** Before the sign-in starts: what is about to happen, in order. */
export function ChatGptSteps() {
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-2.5 text-sm">
        <Step number={1}>Sign in to ChatGPT and approve the request.</Step>
        <Step number={2}>
          Your browser then shows “{CHATGPT_DEAD_PAGE}”. That's expected.
        </Step>
        <Step number={3}>
          Copy the address at the top of that page and paste it here.
        </Step>
      </ol>
      <DeadPagePicture />
    </div>
  );
}

function Step({
  number,
  children,
}: {
  number: number;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs tabular-nums"
      >
        {number}
      </span>
      <span className="pt-px text-pretty">{children}</span>
    </li>
  );
}

/**
 * The page the person lands on, drawn rather than a screenshot so it follows the theme: a browser
 * tab whose address is selected and marked to copy, over the browser's own error.
 */
function DeadPagePicture() {
  return (
    <IllustrationFrame
      className="p-3"
      label={`A browser tab that says “${CHATGPT_DEAD_PAGE}”, with its address at the top marked to copy`}
    >
      <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <div className="flex items-center gap-1.5 border-border border-b bg-muted px-2.5 py-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/15" />
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/15" />
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/15" />
          <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-foreground ring-1 ring-primary/40">
              {LANDING}
            </span>
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 font-medium text-[10px] text-primary-foreground">
              Copy this
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3 px-4 py-4">
          <IconMoodSad className="size-6 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium text-sm">{CHATGPT_DEAD_PAGE}</p>
            <p className="text-muted-foreground text-xs">
              localhost refused to connect.
            </p>
          </div>
        </div>
      </div>
    </IllustrationFrame>
  );
}

/**
 * The address of OpenAI's own sign-in page, pasted in place of the page it lands on: caught here
 * with a sentence that says which page to copy instead.
 */
export function wrongPage(pasted: string): string | null {
  const given = pasted.trim();
  if (!/^https?:\/\//i.test(given)) return null;
  try {
    const host = new URL(given).hostname;
    if (
      host === "auth.openai.com" ||
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host.endsWith(".openai.com")
    )
      return "That's the address of OpenAI's sign-in page. Finish signing in there, then copy the address of the page that won't load.";
  } catch {
    return null;
  }
  return null;
}

/** A paste that is plainly the address to send: it carries the code. */
const carriesCode = (text: string) => /[?&]code=|^code=/i.test(text.trim());

/** The keys that paste, for the sentence that says so when Paste can't read the clipboard. */
function pasteKeys(): string {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : `${navigator.platform} ${navigator.userAgent}`;
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘V" : "Ctrl+V";
}

/** While the sign-in waits: the box the address goes in, with Paste and Finish. */
export function ChatGptPaste({
  busy,
  code,
  failure,
  onCode,
  onFinish,
}: {
  busy: boolean;
  code: string;
  /** What was wrong with the last paste, said under the box, which stays open for another. */
  failure: string | null;
  onCode: (code: string) => void;
  /** Send this text, or what is in the box. */
  onFinish: (text?: string) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const canRead =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.readText === "function";

  // Back from OpenAI's tab: the cursor waits in the box, ready for the paste.
  useEffect(() => {
    const ready = () => {
      if (document.visibilityState !== "visible") return;
      const input = box.current;
      if (!input || input.value.trim()) return;
      input.focus();
      input.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("focus", ready);
    document.addEventListener("visibilitychange", ready);
    return () => {
      window.removeEventListener("focus", ready);
      document.removeEventListener("visibilitychange", ready);
    };
  }, []);

  function send(text: string) {
    setClipboardNote(null);
    onCode(text);
    if (text.trim()) onFinish(text);
  }

  function pasted(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    // Only a whole paste of the address finishes by itself; anything else lands in the box as usual.
    if (!carriesCode(text) && !wrongPage(text)) return;
    event.preventDefault();
    send(text);
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardNote(
          "Your clipboard is empty. Copy the address of the page that won't load, then try again.",
        );
        return;
      }
      send(text);
    } catch {
      setClipboardNote(
        `Your browser didn't let OpenBot paste. Click the box and press ${pasteKeys()}.`,
      );
      box.current?.focus();
    }
  }

  const said = failure ?? clipboardNote;
  return (
    <Field>
      <FieldLabel htmlFor="ai-connection-code">
        Address from your browser
      </FieldLabel>
      <Input
        aria-describedby="ai-connection-code-help"
        aria-invalid={failure ? true : undefined}
        autoComplete="off"
        disabled={busy}
        id="ai-connection-code"
        onChange={(event) => onCode(event.target.value)}
        onPaste={pasted}
        placeholder="http://localhost:1455/auth/callback?code=…"
        ref={box}
        spellCheck={false}
        value={code}
      />
      <div className="flex flex-wrap gap-2">
        {canRead ? (
          <Button
            disabled={busy}
            onClick={() => void paste()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconClipboard />
            Paste
          </Button>
        ) : null}
        <Button
          disabled={busy || code.trim().length === 0}
          onClick={() => onFinish()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? "Checking…" : "Finish"}
        </Button>
      </div>
      {said ? (
        <p
          className={failure ? "text-destructive text-sm" : "text-sm"}
          id="ai-connection-code-help"
          role="alert"
        >
          {said}
        </p>
      ) : (
        <FieldDescription id="ai-connection-code-help">
          It starts with http://localhost:1455.
        </FieldDescription>
      )}
    </Field>
  );
}
