import { prefersReducedMotion } from "./engine-canvas.ts";
import * as cssEngine from "./engine-css.ts";
import * as glyphsEngine from "./engine-glyphs.ts";
import * as painterEngine from "./engine-painter.ts";
import * as particlesEngine from "./engine-particles.ts";
import { type ResolvedLayer, resolveLayers } from "./layers.ts";
import { getPreset } from "./presets.ts";
import { injectBuddyStyles } from "./styles.ts";
import type {
  BuddyAvatarRenderProps,
  LabelContent,
  LayerSlot,
  NamePosition,
  StatusPosition,
} from "./types.ts";

export type BuddyAvatarInstance = {
  update: (props: BuddyAvatarRenderProps) => void;
  destroy: () => void;
  /** The root element created by the renderer (appended into the target). */
  readonly el: HTMLElement;
};

function isShown(content: LabelContent): boolean {
  return content !== null && content !== undefined && content !== "";
}

function setContent(
  el: HTMLElement,
  content: Exclude<LabelContent, null | undefined>,
): void {
  if (content instanceof Node) {
    if (el.childNodes.length !== 1 || el.firstChild !== content) {
      el.replaceChildren(content);
    }
  } else {
    const text = String(content);
    if (el.textContent !== text || el.firstChild?.nodeType !== Node.TEXT_NODE) {
      el.textContent = text;
    }
  }
}

/**
 * Create a buddy avatar inside `target`. Returns an imperative handle; call
 * `update` with new props to reconcile, `destroy` to remove it. Framework
 * wrappers drive this via refs and pass name/status as DOM nodes (portals).
 */
export function createBuddyAvatar(target: HTMLElement): BuddyAvatarInstance {
  injectBuddyStyles();

  const root = document.createElement("div");
  const externalTop = document.createElement("div");
  const frame = document.createElement("div");
  const bubble = document.createElement("div");
  // Layer containers — absolutely-positioned real boxes (unlike the overlay's
  // display:contents), so layer children can carry blend modes and canvas sizing.
  const backdropHolder = document.createElement("div");
  const behindHolder = document.createElement("div");
  const frontHolder = document.createElement("div");
  const overlayHolder = document.createElement("div");
  const thought = document.createElement("div");
  const externalBottom = document.createElement("div");

  externalTop.className = "buddy-avatar__external buddy-avatar__external--top";
  externalBottom.className =
    "buddy-avatar__external buddy-avatar__external--bottom";
  frame.className = "buddy-avatar__frame";
  backdropHolder.className =
    "buddy-avatar__layers buddy-avatar__layers--backdrop";
  behindHolder.className = "buddy-avatar__layers buddy-avatar__layers--behind";
  frontHolder.className = "buddy-avatar__layers buddy-avatar__layers--front";
  overlayHolder.className = "buddy-avatar__overlay";
  thought.className = "buddy-avatar__thought";

  // Bubble children, back to front: backdrop · behind · [media] · front · overlay.
  // The media element is inserted before frontHolder in update().
  bubble.appendChild(backdropHolder);
  bubble.appendChild(behindHolder);
  bubble.appendChild(frontHolder);
  bubble.appendChild(overlayHolder);
  frame.appendChild(bubble);
  frame.appendChild(thought);
  root.appendChild(externalTop);
  root.appendChild(frame);
  root.appendChild(externalBottom);
  target.appendChild(root);

  const nameEl = document.createElement("span");
  const statusEl = document.createElement("span");

  let media: HTMLVideoElement | HTMLImageElement | null = null;
  let mediaSig = "";

  // ---- layers (animated backgrounds & effects) ----
  const layerMap = new Map<string, { el: HTMLElement; teardown: () => void }>();
  let layersSig = "";
  const holderFor = (slot: LayerSlot): HTMLElement =>
    slot === "backdrop"
      ? backdropHolder
      : slot === "behind"
        ? behindHolder
        : frontHolder;

  function applyLayerBox(el: HTMLElement, r: ResolvedLayer): void {
    el.style.cssText =
      "position:absolute;left:0;width:100%;overflow:hidden;pointer-events:none";
    if (r.anchor === "cover") {
      el.style.top = "0";
      el.style.height = "100%";
    } else {
      const hpct = +(
        (r.height ?? (r.anchor === "center" ? 0.5 : 0.35)) * 100
      ).toFixed(3);
      el.style.height = `${hpct}%`;
      if (r.anchor === "bottom") el.style.bottom = "0";
      else if (r.anchor === "top") el.style.top = "0";
      else {
        el.style.top = "50%";
        el.style.transform = "translateY(-50%)";
      }
    }
    if (r.opacity !== 1) el.style.opacity = String(r.opacity);
    if (r.blend && r.blend !== "normal") el.style.mixBlendMode = r.blend;
  }

  function mountMedia(el: HTMLElement, r: ResolvedLayer): () => void {
    if (r.mediaType === "video") {
      const v = document.createElement("video");
      v.className = "buddy-avatar__layer-media";
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.src = r.src as string;
      if (prefersReducedMotion()) {
        v.preload = "metadata";
      } else {
        v.autoplay = true;
      }
      el.appendChild(v);
      return () => {
        try {
          v.pause();
        } catch {
          /* jsdom */
        }
        v.removeAttribute("src");
        v.remove();
      };
    }
    if (r.mediaType === "image") {
      const img = document.createElement("img");
      img.className = "buddy-avatar__layer-media";
      img.src = r.src as string;
      el.appendChild(img);
      return () => img.remove();
    }
    if (typeof console !== "undefined")
      console.warn(
        `[buddy-core] media layer "${r.src}" has an unknown type — not rendered`,
      );
    return () => {};
  }

  function createLayer(r: ResolvedLayer): {
    el: HTMLElement;
    teardown: () => void;
  } {
    const el = document.createElement("div");
    el.className = "buddy-avatar__layer";
    applyLayerBox(el, r);
    let teardown = (): void => {};
    if (r.src) {
      teardown = mountMedia(el, r);
    } else if (r.css) {
      el.style.background = r.css;
    } else if (r.preset) {
      const preset = getPreset(r.preset);
      const engine = preset?.engine;
      if (engine === "particles")
        teardown = particlesEngine.mountLayer(el, r, preset);
      else if (engine === "painter")
        teardown = painterEngine.mountLayer(el, r, preset);
      else if (engine === "glyphs")
        teardown = glyphsEngine.mountLayer(el, r, preset);
      else if (engine === "css") teardown = cssEngine.mountLayer(el, r, preset);
    }
    return { el, teardown };
  }

  function updateLayers(input: BuddyAvatarRenderProps["layers"]): void {
    const resolved = resolveLayers(input);
    const sig = resolved.map((r) => r.key).join("|");
    if (sig === layersSig) return; // unchanged — canvases keep animating, videos keep playing
    layersSig = sig;
    const keep = new Set(resolved.map((r) => r.key));
    for (const [key, entry] of layerMap) {
      if (!keep.has(key)) {
        entry.teardown();
        entry.el.remove();
        layerMap.delete(key);
      }
    }
    for (const r of resolved) {
      let entry = layerMap.get(r.key);
      if (!entry) {
        entry = createLayer(r);
        layerMap.set(r.key, entry);
      }
      holderFor(r.slot).appendChild(entry.el); // (re)order within the holder
    }
  }

  function placeLabel(
    el: HTMLSpanElement,
    kind: "name" | "status",
    content: LabelContent,
    position: NamePosition | StatusPosition,
  ): void {
    if (!isShown(content)) {
      el.remove();
      return;
    }
    setContent(el, content as Exclude<LabelContent, null | undefined>);
    let cls: string;
    let parent: HTMLElement;
    if (position === "top" || position === "bottom") {
      cls = `buddy-avatar__label buddy-avatar__label--${kind}`;
      parent = position === "top" ? externalTop : externalBottom;
    } else if (position === "insetTop" || position === "insetBottom") {
      const edge = position === "insetTop" ? "top" : "bottom";
      cls = `buddy-avatar__inset buddy-avatar__inset--${edge} buddy-avatar__label--${kind}`;
      parent = bubble;
    } else {
      // thoughtBubble (status only)
      cls = "buddy-avatar__thought-bubble";
      parent = thought;
    }
    el.className = cls;
    if (el.parentNode !== parent) parent.appendChild(el);
  }

  function update(props: BuddyAvatarRenderProps): void {
    const fixed = props.size != null;

    // root / frame sizing
    root.className =
      "buddy-avatar" +
      (fixed ? "" : " buddy-avatar--full") +
      (props.className ? " " + props.className : "");
    if (fixed) {
      frame.className = "buddy-avatar__frame";
      frame.style.width = `${props.size}px`;
      frame.style.height = `${props.size}px`;
      frame.style.maxWidth = "";
    } else {
      frame.className = "buddy-avatar__frame buddy-avatar__frame--full";
      frame.style.width = "";
      frame.style.height = "";
      frame.style.maxWidth = props.maxSize != null ? `${props.maxSize}px` : "";
    }

    // bubble shadow
    const shadow = props.shadow ?? "lg";
    bubble.className =
      "buddy-avatar__bubble" +
      (shadow !== "none" ? ` buddy-avatar__bubble--shadow-${shadow}` : "");

    // explicit bubble background — what a transparent buddy composites over.
    // Kept out of mediaSig below so changing it never remounts the video;
    // clearing it restores the --buddy-bg CSS variable from the stylesheet.
    bubble.style.background = props.background != null ? props.background : "";

    // media (video takes priority; remount on poseKey/src change)
    const kind = props.videoSrc ? "video" : props.avatarUrl ? "img" : "none";
    const sig =
      kind === "video"
        ? `v|${props.poseKey ?? ""}|${props.videoSrc}`
        : kind === "img"
          ? `i|${props.avatarUrl}`
          : "none";
    if (sig !== mediaSig) {
      if (media) media.remove();
      if (kind === "video") {
        const v = document.createElement("video");
        v.className = "buddy-avatar__media";
        v.autoplay = true;
        v.muted = true;
        v.playsInline = true;
        v.src = props.videoSrc as string;
        media = v;
      } else if (kind === "img") {
        const img = document.createElement("img");
        img.className = "buddy-avatar__media";
        img.src = props.avatarUrl as string;
        media = img;
      } else {
        media = null;
      }
      if (media) bubble.insertBefore(media, frontHolder);
      mediaSig = sig;
    }
    if (media instanceof HTMLVideoElement) {
      media.loop = props.loop ?? true;
      media.onended = props.onEnded ?? null;
    } else if (media instanceof HTMLImageElement) {
      media.alt = props.alt ?? "Buddy";
    }

    // labels
    placeLabel(nameEl, "name", props.name, props.namePosition ?? "bottom");
    placeLabel(
      statusEl,
      "status",
      props.status,
      props.statusPosition ?? "bottom",
    );

    // keep name before status when both share an external stack
    for (const stack of [externalTop, externalBottom]) {
      if (nameEl.parentNode === stack && statusEl.parentNode === stack) {
        stack.insertBefore(nameEl, statusEl);
      }
      (stack as HTMLElement).style.display = stack.childNodes.length
        ? ""
        : "none";
    }
    thought.style.display = statusEl.parentNode === thought ? "" : "none";

    // layers (reconciled against their own signature — never touches the media)
    updateLayers(props.layers);

    // overlay
    if (props.overlay) {
      if (overlayHolder.firstChild !== props.overlay)
        overlayHolder.replaceChildren(props.overlay);
    } else if (overlayHolder.firstChild) {
      overlayHolder.replaceChildren();
    }
  }

  function destroy(): void {
    if (media) media.onended = null;
    for (const entry of layerMap.values()) entry.teardown();
    layerMap.clear();
    root.remove();
  }

  return { update, destroy, el: root };
}
