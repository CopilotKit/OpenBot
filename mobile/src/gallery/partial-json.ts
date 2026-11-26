/**
 * JSON that may still be arriving: a Bot's tool call streams its arguments a few characters at a time
 * (TOOL_CALL_ARGS), and a card is drawn from them before the last one lands.
 *
 * Reads as much of the text as is whole and closes what is open: an object or an array ends where the
 * text does, a string keeps the letters it has. What can't be told yet is left out rather than guessed:
 * a key with no value, a number at the very end (`12` may be the start of `120`), a half-written
 * `true`, a half-written escape. Text that isn't JSON at all is `undefined`.
 */

class Invalid extends Error {}

type Read = { value: unknown; complete: boolean };

export function parsePartialJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  let at = 0;
  const end = text.length;
  const space = () => {
    while (at < end && /\s/.test(text[at] as string)) at += 1;
  };

  function value(): Read | undefined {
    space();
    if (at >= end) return undefined;
    const first = text[at];
    if (first === "{") return object();
    if (first === "[") return array();
    if (first === '"') return string();
    if (first === "-" || (first !== undefined && first >= "0" && first <= "9"))
      return number();
    return literal();
  }

  function string(): Read {
    at += 1;
    let out = "";
    while (at < end) {
      const char = text[at] as string;
      if (char === '"') {
        at += 1;
        return { value: out, complete: true };
      }
      if (char !== "\\") {
        out += char;
        at += 1;
        continue;
      }
      const escaped = text[at + 1];
      if (escaped === undefined) break;
      if (escaped === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Invalid();
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      const plain: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const read = plain[escaped];
      if (read === undefined) throw new Invalid();
      out += read;
      at += 2;
    }
    at = end;
    return { value: out, complete: false };
  }

  function number(): Read | undefined {
    const match = /^-?\d*\.?\d*(?:[eE][+-]?\d*)?/.exec(text.slice(at));
    const written = match?.[0] ?? "";
    // At the very end of the text: more digits may follow.
    if (at + written.length >= end) {
      at = end;
      return undefined;
    }
    const read = Number(written);
    if (!written || !Number.isFinite(read)) throw new Invalid();
    at += written.length;
    return { value: read, complete: true };
  }

  function literal(): Read | undefined {
    for (const [word, read] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return { value: read, complete: true };
      }
      if (word.startsWith(text.slice(at))) {
        at = end;
        return undefined;
      }
    }
    throw new Invalid();
  }

  function array(): Read {
    at += 1;
    const out: unknown[] = [];
    for (;;) {
      space();
      if (at >= end) return { value: out, complete: false };
      if (text[at] === "]") {
        at += 1;
        return { value: out, complete: true };
      }
      const item = value();
      if (!item) return { value: out, complete: false };
      out.push(item.value);
      if (!item.complete) return { value: out, complete: false };
      space();
      if (at >= end) return { value: out, complete: false };
      if (text[at] === ",") at += 1;
      else if (text[at] !== "]") throw new Invalid();
    }
  }

  function object(): Read {
    at += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      space();
      if (at >= end) return { value: out, complete: false };
      if (text[at] === "}") {
        at += 1;
        return { value: out, complete: true };
      }
      if (text[at] !== '"') throw new Invalid();
      const key = string();
      if (!key.complete) return { value: out, complete: false };
      space();
      if (at >= end) return { value: out, complete: false };
      if (text[at] !== ":") throw new Invalid();
      at += 1;
      const item = value();
      if (!item) return { value: out, complete: false };
      // An own property, as JSON.parse makes it: `__proto__` is a key like any other.
      Object.defineProperty(out, key.value as string, {
        value: item.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (!item.complete) return { value: out, complete: false };
      space();
      if (at >= end) return { value: out, complete: false };
      if (text[at] === ",") at += 1;
      else if (text[at] !== "}") throw new Invalid();
    }
  }

  try {
    const read = value();
    if (!read) return undefined;
    space();
    // Something after a whole value is not JSON.
    if (read.complete && at < end) return undefined;
    return read.value;
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
}

/** The arguments as an object, when what has arrived reads as one. */
export function partialArguments(
  text: string,
): Record<string, unknown> | undefined {
  const read = parsePartialJson(text);
  return typeof read === "object" && read !== null && !Array.isArray(read)
    ? (read as Record<string, unknown>)
    : undefined;
}
