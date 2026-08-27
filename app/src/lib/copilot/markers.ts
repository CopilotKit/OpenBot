/**
 * The two marker phrases, re-exported from the one place they are declared.
 *
 * `shared/` is where the server reads them from too, so a rewording changes both sides at once. This
 * file exists so the browser code keeps importing through `@/`, and so the path to `shared/` is
 * written down once rather than in every renderer.
 */
export { HANDED_OVER, PUT_TO } from "../../../../shared/handoff-markers";
