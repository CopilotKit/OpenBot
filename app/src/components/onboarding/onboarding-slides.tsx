import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

export type OnboardingScene = {
  id: string;
  /** Said under the picture while the scene plays. Empty for a step with one scene and no words. */
  caption: string;
  /** What the scene shows, read in place of the picture. */
  label: string;
  /** Where the scene starts in the video, in seconds. */
  from: number;
};

/**
 * A step's picture in OpenBot's own look (Figma "Onboarding"): one video filling the right-hand pane
 * edge to edge, with the page's soft shapes drawn into it, and the dots and the caption over it.
 *
 * ONE VIDEO A STEP, ITS SCENES ONE AFTER ANOTHER. The video plays round and round, and which scene is
 * on screen is read from where it is (`from`): that scene's dot is the long one and its caption is
 * under it. A scene can come twice (the video ends on the start of its first, so the loop joins up),
 * and has one dot however often it comes. A scene that does not apply (`skip`, the Bot computer for
 * an OpenBot without one) is jumped over, and has no dot.
 *
 * THE VIDEO COVERS THE PANE, which is wider or taller than the video by the window's shape, so what
 * moves in it stays in its middle. Until it has loaded, its first frame (`poster`) stands in.
 *
 * A PICTURE, NOT A CONTROL. It is one image to assistive technology, labelled with what the scene on
 * screen shows, and the caption says it again in words. The dots only say which scene is showing.
 *
 * With reduced motion nothing plays: the first frame holds, with the first scene's words. While the
 * tab is hidden the video waits.
 */
export function OnboardingSlides({
  kind,
  video,
  poster,
  scenes,
  skip = [],
}: {
  /** Which step's picture this is, as `data-demo` (the alternate skins' demos say the same). */
  kind: string;
  video: string;
  poster: string;
  /** Every scene in the video, in the order it plays. */
  scenes: OnboardingScene[];
  /** Scenes to jump over, by id. */
  skip?: string[];
}) {
  const reduced = useReducedMotion() === true;
  const shown = scenes.filter((scene) => !skip.includes(scene.id));
  const dots = [...new Set(shown.map((scene) => scene.id))];
  const [current, setCurrent] = useState(shown[0]?.id);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const pause = () => {
      if (document.hidden) element.pause();
      else void element.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  /** The scene the video is in, and a jump past it when it is skipped. */
  const follow = () => {
    const element = ref.current;
    if (!element) return;
    const time = element.currentTime;
    const at = scenes.findLastIndex((scene) => scene.from <= time);
    const scene = scenes[Math.max(at, 0)];
    if (!scene) return;
    if (skip.includes(scene.id)) {
      const next = scenes.slice(at + 1).find((s) => !skip.includes(s.id));
      element.currentTime = next?.from ?? 0;
      return;
    }
    setCurrent(scene.id);
  };

  const scene = shown.find((candidate) => candidate.id === current) ?? shown[0];
  if (!scene) return null;

  return (
    // The pane's whole height from `lg`; a card of the same shape in one column, on a phone.
    <div
      className="relative aspect-[856/875] w-full overflow-hidden rounded-card lg:absolute lg:inset-0 lg:aspect-auto lg:rounded-none"
      data-demo={kind}
      data-onboarding-slides=""
      data-scene={scene.id}
    >
      <div aria-label={scene.label} className="absolute inset-0" role="img">
        {reduced ? (
          <img
            alt=""
            className="size-full object-cover"
            draggable={false}
            src={poster}
          />
        ) : (
          <video
            aria-hidden
            autoPlay
            className="size-full object-cover"
            loop
            muted
            onTimeUpdate={follow}
            playsInline
            poster={poster}
            preload="auto"
            ref={ref}
            src={video}
          />
        )}
      </div>
      {dots.length > 1 || scene.caption ? (
        <div className="absolute inset-x-0 bottom-6 flex flex-col items-center gap-4 px-8 lg:bottom-19">
          {dots.length > 1 ? (
            <div aria-hidden="true" className="flex gap-1.5">
              {dots.map((id) => (
                <span
                  className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
                    id === scene.id
                      ? "w-5 bg-foreground"
                      : "w-1.5 bg-foreground/20"
                  }`}
                  data-slide-dot={id}
                  key={id}
                />
              ))}
            </div>
          ) : null}
          {scene.caption ? (
            <p className="text-sm max-w-lg text-center text-pretty text-muted-foreground">
              {scene.caption}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
