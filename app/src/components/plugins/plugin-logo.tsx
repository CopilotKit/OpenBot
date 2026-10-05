import { IconPlug } from "@tabler/icons-react";
import { useState } from "react";

export function PluginLogo({ logo }: { logo?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!logo || failedUrl === logo) return <IconPlug className="size-4" />;

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
