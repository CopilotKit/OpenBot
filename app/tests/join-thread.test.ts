import { describe, expect, test } from "bun:test";
import { joinWithin } from "../src/lib/copilot/join-thread";

/** Joining must be FINISHED when it resolves, not merely given up on. */

/** A promise with its settle functions, for driving an await from the test. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled microtask run, so "has it resolved yet" is a fair question. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("joinWithin", () => {
  test("leaves the connect alone when it lands inside the deadline", async () => {
    const connect = deferred();
    let detached = 0;

    const joined = joinWithin({
      connect: connect.promise,
      deadline: new Promise<void>(() => {}),
      detach: async () => {
        detached += 1;
      },
    });

    connect.resolve();
    await joined;

    expect(detached).toBe(0);
  });

  test("ends the connect when the deadline passes first", async () => {
    const connect = deferred();
    const deadline = deferred();
    let detached = 0;

    const joined = joinWithin({
      connect: connect.promise,
      deadline: deadline.promise,
      detach: async () => {
        detached += 1;
        connect.resolve();
      },
    });

    deadline.resolve();
    await joined;

    expect(detached).toBe(1);
  });

  test("waits for the ended connect to finish before saying the join is over", async () => {
    const connect = deferred();
    const deadline = deferred();
    let done = false;

    const joined = joinWithin({
      connect: connect.promise,
      deadline: deadline.promise,
      detach: async () => {},
    }).then(() => {
      done = true;
    });

    deadline.resolve();
    await settleMicrotasks();
    // Detach asked for, connect not back yet. Returning here is what loses the next message.
    expect(done).toBe(false);

    connect.resolve();
    await joined;
    expect(done).toBe(true);
  });

  test("is over, not thrown, when the connect fails", async () => {
    const connect = deferred();
    let detached = 0;

    const joined = joinWithin({
      connect: connect.promise,
      deadline: new Promise<void>(() => {}),
      detach: async () => {
        detached += 1;
      },
    });

    connect.reject(new Error("socket refused"));

    expect(await joined.then(() => "resolved")).toBe("resolved");
    expect(detached).toBe(0);
  });

  test("still waits out the connect when the detach itself fails", async () => {
    const connect = deferred();
    const deadline = deferred();
    let done = false;

    const joined = joinWithin({
      connect: connect.promise,
      deadline: deadline.promise,
      detach: async () => {
        throw new Error("nothing to detach");
      },
    }).then(() => {
      done = true;
    });

    deadline.resolve();
    await settleMicrotasks();
    expect(done).toBe(false);

    connect.reject(new Error("aborted"));
    await joined;
    expect(done).toBe(true);
  });
});
