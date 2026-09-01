export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function avatarFileError(
  file: Pick<File, "size" | "type">,
): string | null {
  if (!AVATAR_TYPES.has(file.type)) {
    return "Choose a PNG, JPEG, or WebP image.";
  }
  if (file.size === 0) return "That image is empty.";
  if (file.size > MAX_AVATAR_BYTES)
    return "Choose an image that is 2 MB or smaller.";
  return null;
}

/** Read one validated image into the small, portable representation the avatar API accepts. */
export async function readAvatarFile(file: File): Promise<string> {
  const invalid = avatarFileError(file);
  if (invalid) throw new Error(invalid);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}
