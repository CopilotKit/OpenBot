// Runs every check on load and renders one row per check:
//   <li data-check="name" data-result="pass|fail|skip|info">name: result — detail</li>
// then <p id="probe-done">probe done: N pass, M fail (K skip, I info)</p>.
// "info" rows report a fact about the web view and are never counted as failures.
(function () {
  'use strict';
  var list = document.getElementById('checks');
  var apiOrigin = location.protocol + '//' + location.hostname + ':8766';
  var counts = { pass: 0, fail: 0, skip: 0, info: 0 };

  function pass(detail) { return { result: 'pass', detail: detail }; }
  function fail(detail) { return { result: 'fail', detail: detail }; }
  function info(detail) { return { result: 'info', detail: detail }; }

  function row(name, result, detail) {
    var li = document.createElement('li');
    li.setAttribute('data-check', name);
    li.setAttribute('data-result', result);
    li.textContent = name + ': ' + result + ' — ' + detail;
    list.appendChild(li);
    counts[result] = (counts[result] || 0) + 1;
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timed out after ' + ms + ' ms')); }, ms);
    })]);
  }

  async function json(response) { return JSON.parse(await response.text()); }

  var checks = [
    ['same-origin-cookie', async function () {
      var set = await fetch('/api/set-cookie', { cache: 'no-store' });
      if (!set.ok) return fail('/api/set-cookie answered ' + set.status);
      var echo = await json(await fetch('/api/echo-cookie', { cache: 'no-store' }));
      var hidden = document.cookie.indexOf('probe_session=') === -1;
      return echo.cookieNames.indexOf('probe_session') !== -1
        ? pass('HttpOnly SameSite=Lax cookie came back on the next fetch; hidden from document.cookie: ' + hidden)
        : fail('cookie not sent back; server saw ' + JSON.stringify(echo.cookieNames));
    }],
    ['cors-blocked-without-headers', async function () {
      try {
        var r = await fetch(apiOrigin + '/nocors', { cache: 'no-store' });
        return fail('cross-origin fetch with no CORS headers was NOT blocked (status ' + r.status + ')');
      } catch (e) {
        return pass('blocked as expected (' + e.name + ': ' + e.message + ')');
      }
    }],
    ['cors-credentialed-get', async function () {
      var r = await fetch(apiOrigin + '/cors', { credentials: 'include', cache: 'no-store' });
      var body = await json(r);
      return r.ok && body.ok ? pass('status ' + r.status + ' with exact origin + credentials') : fail('status ' + r.status);
    }],
    ['cors-preflight-json-post', async function () {
      var r = await fetch(apiOrigin + '/cors', {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Probe': '1' },
        body: JSON.stringify({ hello: 'world' })
      });
      var body = await json(r);
      return r.ok && body.gotProbeHeader
        ? pass('JSON POST with X-Probe got through; server has seen ' + body.preflightsSeen + ' preflight(s)')
        : fail('status ' + r.status + ', body ' + JSON.stringify(body));
    }],
    ['same-site-cross-origin-cookie', async function () {
      await fetch(apiOrigin + '/set-cookie', { credentials: 'include', cache: 'no-store' });
      var echo = await json(await fetch(apiOrigin + '/echo-cookie', { credentials: 'include', cache: 'no-store' }));
      return echo.cookieNames.indexOf('probe_api') !== -1
        ? pass('cookie set by :8766 (SameSite=Lax) came back on a credentialed fetch from :8765 (same site, other origin); :8766 saw ' + JSON.stringify(echo.cookieNames))
        : fail('cookie set by :8766 did NOT come back; :8766 saw ' + JSON.stringify(echo.cookieNames));
    }],
    ['localstorage', function () {
      var key = 'openbot-probe-ls', value = String(Date.now());
      localStorage.setItem(key, value);
      var back = localStorage.getItem(key);
      localStorage.removeItem(key);
      return back === value ? pass('write and read back') : fail('read back ' + back);
    }],
    ['indexeddb', function () {
      return new Promise(function (resolve) {
        if (!window.indexedDB) return resolve(fail('indexedDB is missing'));
        var open = indexedDB.open('openbot-probe', 1);
        open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
        open.onerror = function () { resolve(fail('open failed: ' + open.error)); };
        open.onsuccess = function () {
          var db = open.result;
          var tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put('v1', 'k');
          tx.onerror = function () { resolve(fail('write failed: ' + tx.error)); };
          tx.oncomplete = function () {
            var get = db.transaction('kv').objectStore('kv').get('k');
            get.onerror = function () { resolve(fail('read failed: ' + get.error)); };
            get.onsuccess = function () {
              db.close();
              resolve(get.result === 'v1' ? pass('write and read back') : fail('read back ' + get.result));
            };
          };
        };
      });
    }],
    ['eventsource', function () {
      return new Promise(function (resolve) {
        var got = [];
        var started = performance.now();
        var source = new EventSource('/api/sse');
        source.onmessage = function (e) {
          got.push(e.data);
          if (got.length === 3) {
            source.close();
            resolve(pass('3 events in ' + Math.round(performance.now() - started) + ' ms: ' + got.join(', ')));
          }
        };
        source.onerror = function () {
          if (got.length < 3) { source.close(); resolve(fail('error after ' + got.length + ' event(s)')); }
        };
      });
    }],
    ['streaming-fetch', async function () {
      var started = performance.now();
      var r = await fetch('/api/stream', { cache: 'no-store' });
      if (!r.body || !r.body.getReader) return fail('response has no readable body stream');
      var reader = r.body.getReader(), decoder = new TextDecoder();
      var chunks = 0, text = '', firstAt = null;
      for (;;) {
        var part = await reader.read();
        if (part.done) break;
        chunks++;
        if (firstAt === null) firstAt = performance.now() - started;
        text += decoder.decode(part.value, { stream: true });
      }
      var total = performance.now() - started;
      var lines = text.trim().split('\n').length;
      var detail = lines + ' lines in ' + chunks + ' chunk(s), first after ' + Math.round(firstAt) + ' ms, all after ' + Math.round(total) + ' ms';
      return lines === 3 && chunks >= 2 ? pass(detail + ' (arrived incrementally)') : fail(detail + ' (not incremental)');
    }],
    ['websocket', function () {
      return { result: 'skip', detail: 'not tested: the probe server is standard-library Python with no WebSocket support' };
    }],
    ['file-input-present', function () {
      var input = document.getElementById('file-input');
      return input && input.type === 'file' ? pass('#file-input is a file input') : fail('missing');
    }],
    ['user-agent', function () {
      var ua = navigator.userAgent;
      return ua.indexOf('OpenBotShell-iOS') !== -1 ? pass(ua) : fail('no OpenBotShell-iOS marker: ' + ua);
    }],
    ['secure-context', function () { return info('window.isSecureContext = ' + window.isSecureContext); }],
    ['media-devices', function () {
      return info('navigator.mediaDevices ' + (navigator.mediaDevices ? 'present' : 'missing') +
        ', getUserMedia ' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'present' : 'missing'));
    }],
    ['service-worker', function () { return info("'serviceWorker' in navigator = " + ('serviceWorker' in navigator)); }],
    ['notification-api', function () { return info("'Notification' in window = " + ('Notification' in window)); }]
  ];

  async function run() {
    for (var i = 0; i < checks.length; i++) {
      var name = checks[i][0], fn = checks[i][1];
      try {
        var out = await withTimeout(Promise.resolve().then(fn), 10000);
        row(name, out.result, out.detail);
      } catch (e) {
        row(name, 'fail', 'threw ' + (e && e.name) + ': ' + (e && e.message));
      }
    }
    var done = document.createElement('p');
    done.id = 'probe-done';
    done.textContent = 'probe done: ' + counts.pass + ' pass, ' + counts.fail + ' fail (' +
      counts.skip + ' skip, ' + counts.info + ' info)';
    document.body.appendChild(done);
  }

  document.getElementById('open-popup').addEventListener('click', function () {
    var w = window.open('/popup.html');
    document.getElementById('mic-result').setAttribute('data-popup', w ? 'window' : 'null');
  });

  document.getElementById('ask-mic').addEventListener('click', function () {
    var out = document.getElementById('mic-result');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      out.textContent = 'mic: navigator.mediaDevices.getUserMedia is missing';
      return;
    }
    out.textContent = 'mic: asking';
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      out.textContent = 'mic: granted, ' + stream.getAudioTracks().length + ' audio track(s)';
      stream.getTracks().forEach(function (t) { t.stop(); });
    }, function (e) {
      out.textContent = 'mic: refused (' + e.name + ': ' + e.message + ')';
    });
  });

  run();
})();
