import { type ReactNode, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  type BuddyAvatarInstance,
  type BuddyLayer,
  createBuddyAvatar,
  type NamePosition,
  type ShadowLevel,
  type StatusPosition,
} from "../core/index.ts";

export type BuddyAvatarProps = {
  videoSrc?: string | null;
  avatarUrl?: string | null;
  poseKey?: string | number | null;
  loop?: boolean;
  onEnded?: () => void;
  size?: number;
  maxSize?: number;
  shadow?: ShadowLevel;
  /** CSS background painted behind the (typically transparent) buddy. */
  background?: string | null;
  /** Animated background / effect layers composited inside the bubble. */
  layers?: Array<BuddyLayer> | null;
  alt?: string;
  /** Name label — plain text or any React node. Omit to hide. */
  name?: ReactNode;
  namePosition?: NamePosition;
  /** Status label — plain text or any React node. Omit to hide. */
  status?: ReactNode;
  statusPosition?: StatusPosition;
  className?: string;
  /** Overlay content rendered inside the bubble. */
  children?: ReactNode;
};

const isPrimitive = (n: ReactNode): n is string | number =>
  typeof n === "string" || typeof n === "number";
// "Rich" = a React node that needs its own DOM host (element, array, fragment).
const isRich = (n: ReactNode): boolean =>
  n != null && n !== false && n !== "" && !isPrimitive(n);
const isPresent = (n: ReactNode): boolean =>
  n != null && n !== false && n !== "";

/**
 * React wrapper over the framework-agnostic @tanstack/buddy-core renderer. The core owns
 * the DOM + CSS; here we drive it via a ref and portal any rich name/status/
 * overlay React nodes into DOM hosts the core positions for us.
 */
export function BuddyAvatar(props: BuddyAvatarProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<BuddyAvatarInstance | null>(null);

  // Stable DOM hosts the core places; React portals rich content into them.
  const nameHost = useRef<HTMLSpanElement | null>(null);
  const statusHost = useRef<HTMLSpanElement | null>(null);
  const overlayHost = useRef<HTMLSpanElement | null>(null);
  if (typeof document !== "undefined") {
    if (!nameHost.current) nameHost.current = document.createElement("span");
    if (!statusHost.current)
      statusHost.current = document.createElement("span");
    if (!overlayHost.current) {
      const s = document.createElement("span");
      s.style.display = "contents";
      overlayHost.current = s;
    }
  }

  useLayoutEffect(() => {
    if (!mountRef.current) return;
    instRef.current = createBuddyAvatar(mountRef.current);
    return () => {
      instRef.current?.destroy();
      instRef.current = null;
    };
  }, []);

  const nameRich = isRich(props.name);
  const statusRich = isRich(props.status);

  // Reconcile after every render (portals have filled the hosts by now).
  useLayoutEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    inst.update({
      videoSrc: props.videoSrc,
      avatarUrl: props.avatarUrl,
      poseKey: props.poseKey,
      loop: props.loop,
      onEnded: props.onEnded ?? null,
      size: props.size ?? null,
      maxSize: props.maxSize ?? null,
      shadow: props.shadow,
      background: props.background,
      layers: props.layers,
      alt: props.alt,
      name: isPrimitive(props.name)
        ? props.name
        : nameRich
          ? nameHost.current
          : undefined,
      namePosition: props.namePosition,
      status: isPrimitive(props.status)
        ? props.status
        : statusRich
          ? statusHost.current
          : undefined,
      statusPosition: props.statusPosition,
      overlay: isPresent(props.children) ? overlayHost.current : null,
      className: props.className,
    });
  });

  return (
    <>
      <div ref={mountRef} style={{ display: "contents" }} />
      {nameRich && nameHost.current
        ? createPortal(props.name, nameHost.current)
        : null}
      {statusRich && statusHost.current
        ? createPortal(props.status, statusHost.current)
        : null}
      {isPresent(props.children) && overlayHost.current
        ? createPortal(props.children, overlayHost.current)
        : null}
    </>
  );
}
