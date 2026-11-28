package ai.openbot.shell

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Records what the shell and the WebView do, as JSON lines in files/diagnostics.jsonl and in logcat
 * under the tag OPENBOT_DIAG. On only when a test asked for it (debug and releaseTest builds).
 * Never records cookie values, tickets, verifiers, query string values or request and response bodies.
 */
class Diagnostics(context: Context, val enabled: Boolean, private val testName: String) {
    private val file: File? = if (enabled) File(context.filesDir, "diagnostics.jsonl") else null
    private val lock = Any()

    fun log(kind: String, fields: Map<String, Any?> = emptyMap()) {
        if (!enabled) return
        val entry = JSONObject()
        try {
            for ((key, value) in fields) entry.put(key, toJson(value))
            entry.put("kind", kind)
            if (testName.isNotEmpty()) entry.put("test", testName)
            entry.put("ts", Instant.now().toString())
        } catch (error: JSONException) {
            entry.put("unencodable", kind)
        }
        write(entry.toString())
    }

    /** A message the injected page script posted (already JSON). */
    fun logPage(json: String?, isMainFrame: Boolean) {
        if (!enabled || json == null) return
        val entry = try {
            JSONObject(json)
        } catch (error: JSONException) {
            JSONObject().put("body", json.take(500))
        }
        val kind = entry.optString("kind", "page")
        entry.remove("kind")
        entry.put("kind", "page-$kind")
        entry.put("frameIsMain", isMainFrame)
        if (testName.isNotEmpty()) entry.put("test", testName)
        entry.put("ts", Instant.now().toString())
        write(entry.toString())
    }

    private fun write(line: String) {
        // logcat cuts a line at about 4 KB.
        if (line.length <= 3800) {
            Log.i(TAG, line)
        } else {
            Log.i(TAG, line.take(3800) + "...")
        }
        synchronized(lock) {
            try {
                file?.appendText(line + "\n")
            } catch (error: Exception) {
                Log.w(TAG, "could not write diagnostics.jsonl: ${error.javaClass.simpleName}")
            }
        }
    }

    private fun toJson(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { obj -> value.forEach { (k, v) -> obj.put(k.toString(), toJson(v)) } }
        is Collection<*> -> JSONArray().also { array -> value.forEach { array.put(toJson(it)) } }
        is Array<*> -> JSONArray().also { array -> value.forEach { array.put(toJson(it)) } }
        is Boolean, is Number, is String, is JSONObject, is JSONArray -> value
        else -> value.toString()
    }

    companion object {
        const val TAG = "OPENBOT_DIAG"

        /** scheme://host:port/path plus the names of the query parameters, never their values. */
        fun redact(url: String?): String {
            if (url.isNullOrEmpty()) return ""
            val uri = Uri.parse(url)
            if (!uri.isHierarchical) return (uri.scheme ?: "unparseable") + ":"
            val port = if (uri.port != -1) ":${uri.port}" else ""
            val base = "${uri.scheme}://${uri.host ?: ""}$port${uri.path ?: ""}"
            val names = try {
                uri.queryParameterNames
            } catch (error: Exception) {
                emptySet<String>()
            }
            return if (names.isEmpty()) base else base + "?" + names.joinToString("&")
        }

        /**
         * Injected at document start in every frame while diagnostics are on. Reports through the
         * `OpenBotShellDiagnostics` object the WebView gives the page (WebViewCompat's message
         * listener), looked up when sending.
         */
        val pageScript = """
(function () {
  if (window.__openbotShellDiagnostics) return;
  window.__openbotShellDiagnostics = true;

  function trim(s) { s = String(s); return s.length > 1000 ? s.slice(0, 1000) + '...' : s; }
  function str(v) {
    try {
      if (v instanceof Error) return v.name + ': ' + v.message;
      if (typeof v === 'string') return v;
      return JSON.stringify(v);
    } catch (e) { return String(v); }
  }
  function safeURL(u) {
    try {
      var x = new URL(String(u), location.href);
      var names = [];
      x.searchParams.forEach(function (_, k) { names.push(k); });
      return x.origin + x.pathname + (names.length ? '?' + names.join('&') : '');
    } catch (e) { return 'unparseable'; }
  }
  function originOf(u) { try { return new URL(String(u), location.href).origin; } catch (e) { return ''; } }
  function send(kind, data) {
    try {
      var handler = window.OpenBotShellDiagnostics;
      if (!handler) return;
      data = data || {};
      data.kind = kind;
      data.page = safeURL(location.href);
      handler.postMessage(JSON.stringify(data));
    } catch (e) {}
  }

  ['error', 'warn'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try { send('console', { level: level, message: trim(Array.prototype.map.call(arguments, str).join(' ')) }); } catch (e) {}
      return original.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) {
      send('resource-error', { tag: e.target.tagName, url: safeURL(e.target.src || e.target.href || '') });
    } else {
      send('onerror', { message: trim(e.message), source: safeURL(e.filename || ''), line: e.lineno, col: e.colno });
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    send('unhandledrejection', { reason: trim(str(e.reason)) });
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    send('csp-violation', {
      violatedDirective: e.violatedDirective, effectiveDirective: e.effectiveDirective,
      blockedURI: safeURL(e.blockedURI), sourceFile: safeURL(e.sourceFile || ''), disposition: e.disposition
    });
  });

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      var req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
      var url = req ? req.url : String(input);
      var info = {
        method: String((init && init.method) || (req && req.method) || 'GET').toUpperCase(),
        url: safeURL(url),
        pageOrigin: location.origin,
        requestOrigin: originOf(url),
        mode: (init && init.mode) || (req && req.mode) || 'cors',
        credentials: (init && init.credentials) || (req && req.credentials) || 'same-origin'
      };
      info.crossOrigin = info.requestOrigin !== info.pageOrigin;
      var started = Date.now();
      return originalFetch.apply(this, arguments).then(function (res) {
        info.status = res.status; info.type = res.type; info.ms = Date.now() - started;
        send('fetch', info);
        return res;
      }, function (err) {
        info.error = trim(str(err)); info.errorName = err && err.name; info.ms = Date.now() - started;
        info.likelyCORS = info.crossOrigin && !!err && err.name === 'TypeError';
        send('fetch-failed', info);
        throw err;
      });
    };
  }

  var NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    var Wrapped = function (url, protocols) {
      var ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      var u = safeURL(url);
      ws.addEventListener('open', function () { send('websocket', { event: 'open', url: u }); });
      ws.addEventListener('close', function (e) { send('websocket', { event: 'close', url: u, code: e.code }); });
      ws.addEventListener('error', function () { send('websocket', { event: 'error', url: u }); });
      return ws;
    };
    Wrapped.prototype = NativeWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Wrapped[k] = NativeWebSocket[k]; });
    window.WebSocket = Wrapped;
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__openbotDiag = {
      method: String(method).toUpperCase(), url: safeURL(url),
      pageOrigin: location.origin, requestOrigin: originOf(url)
    };
    this.__openbotDiag.crossOrigin = this.__openbotDiag.requestOrigin !== location.origin;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this, info = xhr.__openbotDiag;
    if (info) {
      info.withCredentials = xhr.withCredentials;
      var started = Date.now();
      xhr.addEventListener('loadend', function () {
        info.status = xhr.status; info.ms = Date.now() - started;
        if (xhr.status === 0) info.likelyCORS = info.crossOrigin;
        send(xhr.status === 0 ? 'xhr-failed' : 'xhr', info);
      });
    }
    return xhrSend.apply(this, arguments);
  };
})();
""".trimIndent()

        /** Evaluated after each main-frame load; returns a JSON string. */
        val snapshotScript = """
(function () {
  function cookieNames() {
    if (!document.cookie) return [];
    return document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }).filter(Boolean);
  }
  var localStorageOK = false;
  try { localStorage.setItem('__openbot_shell', '1'); localStorage.removeItem('__openbot_shell'); localStorageOK = true; } catch (e) {}
  var insets = {};
  try {
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
      'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
      'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)';
    (document.body || document.documentElement).appendChild(el);
    var cs = getComputedStyle(el);
    insets = { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
    el.remove();
  } catch (e) { insets = { error: String(e) }; }
  var viewport = document.querySelector('meta[name="viewport"]');
  return JSON.stringify({
    href: location.origin + location.pathname,
    title: document.title,
    userAgent: navigator.userAgent,
    cookieEnabled: navigator.cookieEnabled,
    documentCookieNames: cookieNames(),
    localStorage: localStorageOK,
    serviceWorker: 'serviceWorker' in navigator,
    mediaDevices: !!navigator.mediaDevices,
    notification: 'Notification' in window,
    isSecureContext: window.isSecureContext,
    nativeShellMark: document.documentElement.getAttribute('data-native-shell'),
    injected: !!window.__OPENBOT_NATIVE_SHELL__,
    bridge: !!window.OpenBotShellAndroid,
    viewport: viewport ? viewport.getAttribute('content') : null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    safeAreaInsets: insets,
    bodyText: document.body ? document.body.innerText.slice(0, 600) : null
  });
})()
""".trimIndent()
    }
}
