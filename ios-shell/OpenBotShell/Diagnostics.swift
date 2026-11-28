import Foundation
import os
import WebKit

/// Records what the shell and the web view do, as JSON lines in Documents/diagnostics.jsonl and in
/// the log with the prefix "OPENBOT_DIAG ". Compiled in always, on only when the launch
/// environment has OPENBOT_SHELL_DIAGNOSTICS=1. Never records cookie values, tokens, query string
/// values or request and response bodies.
final class Diagnostics: NSObject, WKScriptMessageHandler {
    static let handlerName = "openbotShellDiagnostics"

    let enabled: Bool
    /// OPENBOT_SHELL_TEST_NAME, put on every line so CI can tell tests apart (and keep the lines of
    /// tests that use a real account out of public logs).
    private let testName: String
    private let fileURL: URL?
    private let logger = Logger(subsystem: "ai.openbot.shell", category: "diagnostics")
    private let formatter = ISO8601DateFormatter()

    init(enabled: Bool, testName: String = "") {
        self.enabled = enabled
        self.testName = testName
        if enabled,
           let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            fileURL = documents.appendingPathComponent("diagnostics.jsonl")
        } else {
            fileURL = nil
        }
        super.init()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    func log(_ kind: String, _ fields: [String: Any]) {
        guard enabled else { return }
        var entry = fields
        entry["kind"] = kind
        if !testName.isEmpty { entry["test"] = testName }
        entry["ts"] = formatter.string(from: Date())
        var data: Data
        if JSONSerialization.isValidJSONObject(entry),
           let encoded = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) {
            data = encoded
        } else {
            let fallback: [String: Any] = ["kind": kind, "ts": entry["ts"] ?? "", "unencodable": String(describing: fields)]
            data = (try? JSONSerialization.data(withJSONObject: fallback, options: [.sortedKeys])) ?? Data()
        }
        let line = String(data: data, encoding: .utf8) ?? "{}"
        print("OPENBOT_DIAG " + line)
        logger.log("OPENBOT_DIAG \(line, privacy: .public)")
        append(line + "\n")
    }

    private func append(_ text: String) {
        guard let fileURL = fileURL, let data = text.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        var fields: [String: Any] = [:]
        if let body = message.body as? [String: Any] {
            fields = body
        } else {
            fields["body"] = String(describing: message.body)
        }
        let kind = (fields["kind"] as? String) ?? "page"
        fields["kind"] = nil
        fields["frameIsMain"] = message.frameInfo.isMainFrame
        log("page-" + kind, fields)
    }

    /// scheme://host:port/path plus the names of the query parameters, never their values.
    static func redact(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.scheme ?? "unparseable"
        }
        let names = components.queryItems?.map { $0.name } ?? []
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        let base = components.string ?? (url.scheme ?? "")
        return names.isEmpty ? base : base + "?" + names.joined(separator: "&")
    }

    /// Injected at document start in every frame.
    static let pageScript = #"""
(function () {
  if (window.__openbotShellDiagnostics) return;
  window.__openbotShellDiagnostics = true;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openbotShellDiagnostics;
  if (!handler) return;

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
      data = data || {};
      data.kind = kind;
      data.page = safeURL(location.href);
      handler.postMessage(data);
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

  // WebSockets: the scheme and path they open, and when they open and close (never messages).
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
"""#

    /// Evaluated after each main-frame load; returns a JSON string.
    static let snapshotScript = #"""
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
  var href = location.origin + location.pathname;
  return JSON.stringify({
    href: href,
    title: document.title,
    userAgent: navigator.userAgent,
    cookieEnabled: navigator.cookieEnabled,
    documentCookieNames: cookieNames(),
    localStorage: localStorageOK,
    serviceWorker: 'serviceWorker' in navigator,
    mediaDevices: !!navigator.mediaDevices,
    notification: 'Notification' in window,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    isSecureContext: window.isSecureContext,
    viewport: viewport ? viewport.getAttribute('content') : null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    safeAreaInsets: insets,
    bodyText: document.body ? document.body.innerText.slice(0, 600) : null
  });
})()
"""#
}
