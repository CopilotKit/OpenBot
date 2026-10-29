import type * as React from "react";
import { useLayoutEffect } from "react";
import { PageColumn, PageHeader } from "@/components/layout/page-parts";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The `dark` class on the document follows the browser's colour scheme. The app
 * follows the theme a person picks, but keeps it in its own localStorage, which
 * an extension page cannot read, so the browser's setting is the only signal here.
 */
function useColourScheme() {
  useLayoutEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const apply = () =>
      document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

/**
 * The frame every extension page sits in. `prose` is OpenBot's own column and header from
 * `page-parts`, minus the sidebar toggle and back button that belong to the app's router.
 */
export function Page({
  children,
  description,
  title,
  width,
}: {
  children?: React.ReactNode;
  description?: React.ReactNode;
  title: string;
  width: "popup" | "prose";
}) {
  useColourScheme();
  if (width === "prose") {
    return (
      <PageColumn bar={false}>
        <PageHeader title={title} description={description} />
        {children}
      </PageColumn>
    );
  }
  return (
    // Deviation from openbot-screen-layout: a toolbar popup has no pane and no sidebar, and Chrome
    // sizes it to its content, so it sets its own width and padding (`px-4` is PageColumn's gutter).
    <div className="w-96 px-4 py-4">
      <PageHeader title={title} description={description} />
      {children}
    </div>
  );
}
