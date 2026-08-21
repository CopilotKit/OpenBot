/**
 * Screenshot-to-page coordinate conversion.
 *
 * Geometry only. Talking to a computer moved to `lib/computers/control.ts`; this stayed because it is
 * about the image on screen rather than about the machine behind it.
 */

/**
 * Convert display coordinates on a scaled screenshot into browser viewport coordinates.
 */
export function pageCoordinates(
  image: { naturalWidth: number; naturalHeight: number },
  rect: { left: number; top: number; width: number; height: number },
  event: { clientX: number; clientY: number },
): { x: number; y: number } | null {
  if (!rect.width || !rect.height) return null;
  if (!image.naturalWidth || !image.naturalHeight) return null;

  const withinX = event.clientX - rect.left;
  const withinY = event.clientY - rect.top;

  return {
    x: Math.round((withinX / rect.width) * image.naturalWidth),
    y: Math.round((withinY / rect.height) * image.naturalHeight),
  };
}
