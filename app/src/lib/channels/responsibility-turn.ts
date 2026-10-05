/**
 * The responsibility turn reader, re-exported from the one place it is declared.
 *
 * See `routine-firing.ts` beside this file: the server builds the message from `shared/`, and the
 * browser keeps importing through `@/`.
 */
export { readResponsibilityTurn } from "../../../../shared/responsibility-turn";
