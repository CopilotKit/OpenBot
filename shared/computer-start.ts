/**
 * How long one of a Bot's computer calls waits for its computer to start, from the moment it is made.
 *
 * A computer that was asleep, or is new, costs a node, a pod and a browser launch to come up, and on a
 * busy day that has taken over a minute and a half. A call that gave up sooner told the model the
 * computer was "still starting", and a task's plan read that as a step that failed.
 *
 * The server waits this long for a Bot's own turn. A call the app makes is answered sooner, inside
 * what an edge in front of the server lets one request wait, so the app asks again while the answer
 * is that the computer is still starting, until this much time has gone (app/src/lib/computers/call.ts).
 * The Computer panel waits past it before it calls a start slow (components/computer/computer-view.tsx).
 */
export const COMPUTER_START_WAIT_MS = 180_000;
