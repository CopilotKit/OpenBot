import { IconPhotoUp, IconTrash } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { readAvatarFile } from "@/lib/avatar";
import { Button } from "./button";

/** The shared upload/remove controls used by both person and coworker avatars. */
export function AvatarUploadActions({
  label,
  hasImage,
  hasCustomImage = hasImage,
  onChange,
  disabled = false,
}: {
  label: string;
  hasImage: boolean;
  /** A provider image is visible but cannot be removed; a custom image can. */
  hasCustomImage?: boolean;
  onChange: (image: string | null) => Promise<unknown>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (image: string | null) => {
    setError(null);
    setSaving(true);
    try {
      await onChange(image);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the avatar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input
        accept="image/png,image/jpeg,image/webp"
        aria-label={`Choose ${label}`}
        className="sr-only"
        disabled={disabled || saving}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          // Let selecting the same file again trigger change after a refusal.
          event.target.value = "";
          if (!file) return;
          try {
            await save(await readAvatarFile(file));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "That image could not be read.");
          }
        }}
        ref={input}
        type="file"
      />
      <div className="flex gap-2">
        <Button
          disabled={disabled || saving}
          onClick={() => input.current?.click()}
          size="sm"
          variant="outline"
        >
          <IconPhotoUp />
          {saving ? "Saving…" : hasImage ? "Replace" : "Upload"}
        </Button>
        {hasCustomImage ? (
          <Button
            aria-label={`Remove ${label}`}
            disabled={disabled || saving}
            onClick={() => void save(null)}
            size="icon-sm"
            variant="ghost"
          >
            <IconTrash />
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="max-w-52 text-right text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
