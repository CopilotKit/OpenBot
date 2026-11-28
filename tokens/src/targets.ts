/**
 * Every copy of the scheme outside this package. Code that can import the package imports it
 * instead and isn't listed (the Recorder's in-page notice does). A new copy goes here, or the test
 * that holds the copies to the scheme can't see it.
 */

/** Hand-written files with one or more regions the generator fills. */
export const REGIONS = [
  // The web app, and the Recorder's pages, which import it.
  "app/src/theme.css",
  // The live orb, which keeps the light page's ground in both themes.
  "app/src/styles.css",
  // OpenBot Desktop's setup window, its sign-in page and its native first paint.
  "desktop/src/styles.css",
  "desktop/src-tauri/src/connected/sign_in.rs",
  "desktop/src-tauri/src/first_paint.rs",
] as const;

/** Files the generator writes whole. */
export const WHOLE_FILES = [
  // The phone app, which builds from mobile/ alone and can't import a workspace package.
  "mobile/src/scheme.ts",
  // The web app's manifest, whose colors a phone paints an added app's splash and bar with.
  "app/public/manifest.webmanifest",
] as const;
