/**
 * The routine firing frame's reader, re-exported from the one place it is declared.
 *
 * `shared/` is where the server builds the frame from too, so a rewording changes both sides at
 * once. This file exists so the browser code keeps importing through `@/`, and so the path to
 * `shared/` is written down once rather than in every renderer.
 */
export { readFiring } from "../../../../shared/routine-firing";
