import { buttonVariants } from "@/components/ui/button";
import { DESKTOP_LINK } from "./desktop-return";

/**
 * What a browser opened at the address of OpenBot on one computer shows, outside its app.
 *
 * The personal edition only admits requests carrying its install's token, which only its app has, so
 * that browser is refused on its first request (`refusedForNotBeingItsApp`). Nothing behind sign-in
 * can be drawn there, so the page says where OpenBot opens and offers the link that brings its app
 * forward. The same page as /desktop-return, so the two read as one place.
 */
export function OpenFromApp() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">Open OpenBot from its app</h1>
        <p className="text-balance text-sm text-muted-foreground">
          This OpenBot only answers its own app, not a browser.
        </p>
        {/* An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link. */}
        <a className={buttonVariants()} href={DESKTOP_LINK}>
          Open OpenBot
        </a>
      </div>
    </main>
  );
}
