# @openbot/buddy

Animated Bot avatars ("buddies"): a still picture and a short looping clip per pose.

Vendored from labs-buddy (`packages/buddy-core`, `buddy-react` and `buddy-file`, commit 15fa48f),
whose packages are not published yet. The only changes: `react/` imports `../core` instead of `@tanstack/buddy-core`,
imports drop their `.ts` extension, and Biome formatted it. Replace this folder with the published `@tanstack/buddy-*` packages once
they exist.

- `core`: the pose controller and the DOM renderer.
- `react`: `useBuddy` and `<BuddyAvatar>`.
- `file`: reading and writing a `.buddy` file (a zip of `metadata.json`, the avatar and one clip per
  pose). `file/browser` loads one into object URLs.
