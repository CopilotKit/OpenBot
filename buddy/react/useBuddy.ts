import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type BuddyClips,
  type BuddyController,
  type BuddyOptions,
  createBuddyController,
  type SetPoseOptions,
  toPoseClips,
} from "../core/index";

export type { BuddyClips };
/** React `useBuddy` options — the shared adapter options shape. */
export type UseBuddyOptions = BuddyOptions;

/**
 * React binding for the @tanstack/buddy-core pose controller. Returns `buddyProps` to
 * spread onto <BuddyAvatar /> plus imperative pose setters.
 *
 *   const { buddyProps, setPose } = useBuddy({ avatarUrl, clips, homePose })
 *   <BuddyAvatar {...buddyProps} size={160} />
 */
export function useBuddy(options: UseBuddyOptions) {
  const ref = useRef<BuddyController | null>(null);
  if (!ref.current) {
    ref.current = createBuddyController({
      clips: toPoseClips(options.clips),
      homePose: options.homePose,
      avatarUrl: options.avatarUrl ?? null,
    });
  }
  const controller = ref.current;

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    controller.setOptions({
      clips: toPoseClips(options.clips),
      homePose: options.homePose,
      avatarUrl: options.avatarUrl ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.clips, options.homePose, options.avatarUrl]);

  useEffect(() => () => controller.destroy(), [controller]);

  const buddyProps = {
    avatarUrl: state.avatarUrl,
    videoSrc: state.videoSrc,
    poseKey: state.poseKey,
    loop: state.loop,
    onEnded: controller.ended,
    background: options.background,
    layers: options.layers,
    alt: options.name,
  };

  return {
    pose: state.pose,
    home: state.home,
    buddyProps,
    setPose: controller.setPose as (
      pose: string,
      opts?: SetPoseOptions,
    ) => void,
    queuePose: controller.queuePose as (
      pose: string,
      opts?: SetPoseOptions,
    ) => void,
    rest: controller.rest,
  };
}
