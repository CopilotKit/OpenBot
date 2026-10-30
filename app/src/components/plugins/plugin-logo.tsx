import { IconPlug } from "@tabler/icons-react";
import { useState } from "react";

/**
 * An app's logo, or its initial where it has none.
 *
 * The initial rather than a generic plug because a list of apps that all show the same plug is a
 * column of identical tiles, which tells nobody anything; "T" and "G" at least tell Todoist from
 * GitHub at a glance. The plug is left only for a caller with no name to take an initial from.
 */
export function PluginLogo({
  logo,
  name,
}: {
  logo?: string | null;
  name?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!logo || failedUrl === logo) {
    return name ? <AppInitial name={name} /> : <IconPlug className="size-4" />;
  }

  return (
    <img
      alt=""
      src={logo}
      className="size-6 object-contain"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailedUrl(logo)}
    />
  );
}

/** The first letter of an app's name, drawn where its logo would go. Hidden from screen readers: the row's title already says the name. */
export function AppInitial({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span aria-hidden className="font-medium text-sm leading-none">
      {initial || "?"}
    </span>
  );
}
