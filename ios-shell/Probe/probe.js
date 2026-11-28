// Runs every check on load and renders one row per check:
//   <li data-check="name" data-result="pass|fail|skip|info">name: result — detail</li>
// then <p id="probe-done">probe done: N pass, M fail (K skip, I info)</p>.
// "info" rows report a fact about the web view and are never counted as failures.
(() => {
  const list = document.getElementById("checks");
  const apiOrigin = `${location.protocol}//${location.hostname}:8766`;
  const counts = { pass: 0, fail: 0, skip: 0, info: 0 };

  function pass(detail) {
    return { result: "pass", detail: detail };
  }
  function fail(detail) {
    return { result: "fail", detail: detail };
  }
  function info(detail) {
    return { result: "info", detail: detail };
  }

  function row(name, result, detail) {
    const li = document.createElement("li");
    li.setAttribute("data-check", name);
    li.setAttribute("data-result", result);
    li.textContent = `${name}: ${result} — ${detail}`;
    list.appendChild(li);
    counts[result] = (counts[result] || 0) + 1;
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
  }

  async function json(response) {
    return JSON.parse(await response.text());
  }

  const checks = [
    [
      "same-origin-cookie",
      async () => {
        const set = await fetch("/api/set-cookie", { cache: "no-store" });
        if (!set.ok) return fail(`/api/set-cookie answered ${set.status}`);
        const echo = await json(
          await fetch("/api/echo-cookie", { cache: "no-store" }),
        );
        const hidden = document.cookie.indexOf("probe_session=") === -1;
        return echo.cookieNames.indexOf("probe_session") !== -1
          ? pass(
              "HttpOnly SameSite=Lax cookie came back on the next fetch; hidden from document.cookie: " +
                hidden,
            )
          : fail(
              "cookie not sent back; server saw " +
                JSON.stringify(echo.cookieNames),
            );
      },
    ],
    [
      "cors-blocked-without-headers",
      async () => {
        try {
          const r = await fetch(`${apiOrigin}/nocors`, { cache: "no-store" });
          return fail(
            "cross-origin fetch with no CORS headers was NOT blocked (status " +
              r.status +
              ")",
          );
        } catch (e) {
          return pass(`blocked as expected (${e.name}: ${e.message})`);
        }
      },
    ],
    [
      "cors-credentialed-get",
      async () => {
        const r = await fetch(`${apiOrigin}/cors`, {
          credentials: "include",
          cache: "no-store",
        });
        const body = await json(r);
        return r.ok && body.ok
          ? pass(`status ${r.status} with exact origin + credentials`)
          : fail(`status ${r.status}`);
      },
    ],
    [
      "cors-preflight-json-post",
      async () => {
        const r = await fetch(`${apiOrigin}/cors`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-Probe": "1" },
          body: JSON.stringify({ hello: "world" }),
        });
        const body = await json(r);
        return r.ok && body.gotProbeHeader
          ? pass(
              "JSON POST with X-Probe got through; server has seen " +
                body.preflightsSeen +
                " preflight(s)",
            )
          : fail(`status ${r.status}, body ${JSON.stringify(body)}`);
      },
    ],
    [
      "same-site-cross-origin-cookie",
      async () => {
        await fetch(`${apiOrigin}/set-cookie`, {
          credentials: "include",
          cache: "no-store",
        });
        const echo = await json(
          await fetch(`${apiOrigin}/echo-cookie`, {
            credentials: "include",
            cache: "no-store",
          }),
        );
        return echo.cookieNames.indexOf("probe_api") !== -1
          ? pass(
              "cookie set by :8766 (SameSite=Lax) came back on a credentialed fetch from :8765 (same site, other origin); :8766 saw " +
                JSON.stringify(echo.cookieNames),
            )
          : fail(
              "cookie set by :8766 did NOT come back; :8766 saw " +
                JSON.stringify(echo.cookieNames),
            );
      },
    ],
    [
      "localstorage",
      () => {
        const key = "openbot-probe-ls",
          value = String(Date.now());
        localStorage.setItem(key, value);
        const back = localStorage.getItem(key);
        localStorage.removeItem(key);
        return back === value
          ? pass("write and read back")
          : fail(`read back ${back}`);
      },
    ],
    [
      "indexeddb",
      () =>
        new Promise((resolve) => {
          if (!window.indexedDB) return resolve(fail("indexedDB is missing"));
          const open = indexedDB.open("openbot-probe", 1);
          open.onupgradeneeded = () => {
            open.result.createObjectStore("kv");
          };
          open.onerror = () => {
            resolve(fail(`open failed: ${open.error}`));
          };
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("kv", "readwrite");
            tx.objectStore("kv").put("v1", "k");
            tx.onerror = () => {
              resolve(fail(`write failed: ${tx.error}`));
            };
            tx.oncomplete = () => {
              const get = db.transaction("kv").objectStore("kv").get("k");
              get.onerror = () => {
                resolve(fail(`read failed: ${get.error}`));
              };
              get.onsuccess = () => {
                db.close();
                resolve(
                  get.result === "v1"
                    ? pass("write and read back")
                    : fail(`read back ${get.result}`),
                );
              };
            };
          };
        }),
    ],
    [
      "eventsource",
      () =>
        new Promise((resolve) => {
          const got = [];
          const started = performance.now();
          const source = new EventSource("/api/sse");
          source.onmessage = (e) => {
            got.push(e.data);
            if (got.length === 3) {
              source.close();
              resolve(
                pass(
                  "3 events in " +
                    Math.round(performance.now() - started) +
                    " ms: " +
                    got.join(", "),
                ),
              );
            }
          };
          source.onerror = () => {
            if (got.length < 3) {
              source.close();
              resolve(fail(`error after ${got.length} event(s)`));
            }
          };
        }),
    ],
    [
      "streaming-fetch",
      async () => {
        const started = performance.now();
        const r = await fetch("/api/stream", { cache: "no-store" });
        if (!r.body?.getReader)
          return fail("response has no readable body stream");
        const reader = r.body.getReader(),
          decoder = new TextDecoder();
        let chunks = 0,
          text = "",
          firstAt = null;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          chunks++;
          if (firstAt === null) firstAt = performance.now() - started;
          text += decoder.decode(part.value, { stream: true });
        }
        const total = performance.now() - started;
        const lines = text.trim().split("\n").length;
        const detail =
          lines +
          " lines in " +
          chunks +
          " chunk(s), first after " +
          Math.round(firstAt) +
          " ms, all after " +
          Math.round(total) +
          " ms";
        return lines === 3 && chunks >= 2
          ? pass(`${detail} (arrived incrementally)`)
          : fail(`${detail} (not incremental)`);
      },
    ],
    [
      "websocket",
      () => ({
        result: "skip",
        detail:
          "not tested: the probe server is standard-library Python with no WebSocket support",
      }),
    ],
    [
      "file-input-present",
      () => {
        const input = document.getElementById("file-input");
        return input && input.type === "file"
          ? pass("#file-input is a file input")
          : fail("missing");
      },
    ],
    [
      "user-agent",
      () => {
        const ua = navigator.userAgent;
        const marker = ua.includes("Android")
          ? "OpenBotShell-Android/"
          : "OpenBotShell-iOS/";
        return ua.includes(marker)
          ? pass(ua)
          : fail(`missing ${marker} marker`);
      },
    ],
    [
      "secure-context",
      () => info(`window.isSecureContext = ${window.isSecureContext}`),
    ],
    [
      "media-devices",
      () =>
        info(
          "navigator.mediaDevices " +
            (navigator.mediaDevices ? "present" : "missing") +
            ", getUserMedia " +
            (navigator.mediaDevices?.getUserMedia ? "present" : "missing"),
        ),
    ],
    [
      "service-worker",
      () =>
        info(`'serviceWorker' in navigator = ${"serviceWorker" in navigator}`),
    ],
    [
      "notification-api",
      () => info(`'Notification' in window = ${"Notification" in window}`),
    ],
  ];

  async function run() {
    for (let i = 0; i < checks.length; i++) {
      const name = checks[i][0],
        fn = checks[i][1];
      try {
        const out = await withTimeout(Promise.resolve().then(fn), 10000);
        row(name, out.result, out.detail);
      } catch (e) {
        row(name, "fail", `threw ${e?.name}: ${e?.message}`);
      }
    }
    const done = document.createElement("p");
    done.id = "probe-done";
    done.textContent =
      "probe done: " +
      counts.pass +
      " pass, " +
      counts.fail +
      " fail (" +
      counts.skip +
      " skip, " +
      counts.info +
      " info)";
    document.body.appendChild(done);
  }

  document.getElementById("open-popup").addEventListener("click", () => {
    const w = window.open("/popup.html");
    document
      .getElementById("mic-result")
      .setAttribute("data-popup", w ? "window" : "null");
  });

  document.getElementById("ask-mic").addEventListener("click", () => {
    const out = document.getElementById("mic-result");
    if (!navigator.mediaDevices?.getUserMedia) {
      out.textContent = "mic: navigator.mediaDevices.getUserMedia is missing";
      return;
    }
    out.textContent = "mic: asking";
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        out.textContent = `mic: granted, ${stream.getAudioTracks().length} audio track(s)`;
        stream.getTracks().forEach((t) => {
          t.stop();
        });
      },
      (e) => {
        out.textContent = `mic: refused (${e.name}: ${e.message})`;
      },
    );
  });

  run();
})();
