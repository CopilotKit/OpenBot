/**
 * What `promise` rejected with, or undefined when it resolved, read with a plain `await`.
 *
 * A test of something fake-indexeddb settles uses this, not `expect(promise).rejects`. Bun's `rejects` waits for a
 * promise that is still pending by blocking in a loop of its own, and that loop runs no `setImmediate` callback until a
 * timer or I/O wakes it. fake-indexeddb runs every request, commit and abort on `setImmediate`. Run alone, a file has no
 * timer waiting and the wait is instant; in the full suite an earlier file's timer is still waiting, and
 * database.test.ts's wait for an abort one `setImmediate` would have delivered ran past the 5 s test timeout on CI.
 */
export function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
