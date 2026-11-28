import Foundation
import SafariServices
import UIKit
import WebKit

/// What the web view tells the rest of the shell.
protocol WebControllerDelegate: AnyObject {
    /// A message the page posted to `openbotShell`, from the main frame on the web app's origin.
    func webController(_ controller: WebController, didReceive message: [String: Any])
    /// A main-frame navigation to `<base>/api/auth/hosted/sign-in`. Return true to cancel it.
    func webController(_ controller: WebController, shouldInterceptHostedSignIn url: URL) -> Bool
    /// Whether a tapped link may take the web view to another site (the web sign-in fallback).
    func webControllerAllowsLeavingOrigin(_ controller: WebController) -> Bool
    /// A main-frame load failed or never answered.
    func webController(_ controller: WebController, didFailLoad message: String)
    /// A main-frame load committed (a new document).
    func webControllerDidCommit(_ controller: WebController)
    /// A main-frame load finished.
    func webControllerDidFinish(_ controller: WebController)
    /// WebKit's content process ended and the page is being loaded again.
    func webControllerContentProcessRestarted(_ controller: WebController)
    /// Another site's page failed to load; the web view is going back to the web app's last page.
    func webController(_ controller: WebController, otherSiteFailed url: URL)
    /// The web view's URL changed, by a load or by the page's own router (pushState).
    func webController(_ controller: WebController, didChangeURL url: URL?)
}

/// Owns the one WKWebView, its navigation and UI delegate, the page bridge and the load watchdog.
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let bridgeName = "openbotShell"
    /// WebKit fails some blocked loads without a word: a load that neither commits nor fails in this
    /// long shows the load-failure overlay.
    static let watchdogSeconds: TimeInterval = 20

    let config: ShellConfig
    let webView: WKWebView
    weak var delegate: WebControllerDelegate?

    private let diagnostics: Diagnostics
    private var lastRequestedURL: URL?
    private var watchdog: DispatchWorkItem?
    /// The page said `ready` since the last main-frame commit.
    private(set) var pageReady = false
    /// The last main-frame load failed (so the shell reloads when the connection comes back).
    private(set) var lastLoadFailed = false
    /// One hosted sign-in URL the shell decided to let through after all.
    private var allowHostedOnce: URL?
    private var urlObservation: NSKeyValueObservation?
    /// The last page of the web app's own origin that committed (never a sign-in hand-off URL): where
    /// the app goes back to after another site's page fails, and what a retry loads.
    private(set) var lastOwnOriginURL: URL?
    /// Set by the shell while someone is signed in: back and forward then never reach another
    /// site's page or the sign-in page (they would walk back through the identity provider).
    var signedIn = false
    /// Files the page downloads, by download, until the share sheet has them.
    private var downloadFiles: [ObjectIdentifier: URL] = [:]

    init(config: ShellConfig, diagnostics: Diagnostics) {
        self.config = config
        self.diagnostics = diagnostics

        let configuration = WKWebViewConfiguration()
        // Persistent store, so cookies and localStorage survive a relaunch like they do in Safari.
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        // Audio and video play in the page instead of jumping to the full-screen player.
        configuration.allowsInlineMediaPlayback = true
        // Appended to the Safari-like UA: the web app recognizes the shell by it too.
        configuration.applicationNameForUserAgent = "OpenBotShell-iOS/\(config.version)"
        if diagnostics.enabled {
            // Reports console errors, failed requests and CSP violations from every frame.
            configuration.userContentController.addUserScript(
                WKUserScript(source: Diagnostics.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
            )
            configuration.userContentController.add(diagnostics, name: Diagnostics.handlerName)
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Swipe from the edge goes back and forward, as in Safari.
        webView.allowsBackForwardNavigationGestures = true
        // The shell lays the web view out between the status bar and the tab bar, so the page needs
        // no safe-area insets of its own.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // No white flash before the first paint in dark mode.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // Nothing white behind or around an empty page.
        webView.underPageBackgroundColor = .systemBackground
        // UI tests find the web view by this identifier.
        webView.accessibilityIdentifier = "openbot-webview"
        // No form-assistant bar above the keyboard (KeyboardAccessory.swift), so the keyboard goes
        // away by dragging the page down.
        webView.scrollView.keyboardDismissMode = .interactive
        // A page too short to scroll (Home) still takes the drag that dismisses the keyboard.
        webView.scrollView.alwaysBounceVertical = true
        #if DEBUG
        // Lets Safari's Web Inspector attach to debug builds.
        webView.isInspectable = true
        #endif
        self.webView = webView
        super.init()

        // The page learns it is in the shell before its first script runs: main frame only, and
        // only on the web app's own origin (an identity provider's page is not told).
        let marker = WebController.shellMarkerScript(config: config)
        configuration.userContentController.addUserScript(
            WKUserScript(source: marker, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        // Through a weak proxy: the content controller retains its handlers.
        configuration.userContentController.add(WeakScriptMessageHandler(self), name: WebController.bridgeName)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        hideKeyboardAccessory(when: "init")
        installKeyboardDragDismiss()
        installBackSwipe()
        // Also sees the page's own route changes, which no navigation delegate call reports.
        urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
            let url = webView.url
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.delegate?.webController(self, didChangeURL: url)
            }
        }
    }

    static func shellMarkerScript(config: ShellConfig) -> String {
        let origin = config.baseURL.absoluteString
        let version = jsString(config.version)
        return """
        (function () {
          if (location.origin !== \(jsString(origin))) return;
          window.__OPENBOT_NATIVE_SHELL__ = Object.freeze({ platform: "ios", version: \(version), bridge: 1 });
        })();
        """
    }

    /// A Swift string as a JavaScript string literal.
    static func jsString(_ value: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }
        return "\"\""
    }

    // MARK: - Loading

    /// Loads a path of the web app (or any URL) as a full page load. `headers` go on this one
    /// request; `remember` is what a retry or a restarted web process loads instead of `url` (the
    /// sign-in hand-off's URL carries a one-time ticket and must never be loaded twice).
    func load(_ url: URL, headers: [String: String] = [:], remember: URL? = nil) {
        let keep = remember ?? url
        lastRequestedURL = isHandoffURL(keep) ? lastOwnOriginURL : keep
        lastLoadFailed = false
        diagnostics.log("load", ["url": Diagnostics.redact(url)])
        armWatchdog(for: url)
        var request = URLRequest(url: url)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        webView.load(request)
    }

    /// A URL of the sign-in hand-off (`/api/auth/shell/...`): never kept, never loaded again.
    func isHandoffURL(_ url: URL?) -> Bool {
        guard let url = url, config.isOwnOrigin(url) else { return false }
        return url.path.hasPrefix("/api/auth/shell/")
    }

    /// Loads about:blank (no network) and calls back when it has loaded, or after 3 s.
    func loadBlank(_ done: @escaping () -> Void) {
        var called = false
        let finish = {
            guard !called else { return }
            called = true
            done()
        }
        blankDone = finish
        webView.loadHTMLString("<!doctype html><title></title>", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
    }
    private var blankDone: (() -> Void)?

    func load(path: String) {
        load(config.url(path))
    }

    /// Opens a page of the web app: through the page's own router with `openbot:open` when the page
    /// is up, else by loading it. Calls back with "event" or "load".
    func open(path: String, completion: ((String) -> Void)? = nil) {
        guard pageReady, let current = webView.url, config.isOwnOrigin(current) else {
            diagnostics.log("open", ["path": path, "mode": "load", "why": "page-not-ready"])
            load(path: path)
            completion?("load")
            return
        }
        let script = """
        (function (p) {
          try {
            return window.dispatchEvent(new CustomEvent("openbot:open", { cancelable: true, detail: { path: p } }));
          } catch (e) { return true; }
        })(\(WebController.jsString(path)))
        """
        webView.evaluateJavaScript(script) { [weak self] result, error in
            guard let self = self else { return }
            // dispatchEvent answers false when a listener called preventDefault: the page handled it.
            if let notCancelled = result as? Bool, notCancelled == false {
                self.diagnostics.log("open", ["path": path, "mode": "event"])
                completion?("event")
            } else {
                self.diagnostics.log("open", [
                    "path": path, "mode": "load",
                    "why": error == nil ? "not-handled" : "script-error",
                ])
                self.load(path: path)
                completion?("load")
            }
        }
    }

    func retry() {
        // Only the web app's own pages are retried: another site's page that failed is left behind.
        var target = lastRequestedURL
        if let url = target, !config.isOwnOrigin(url) || isHandoffURL(url) { target = lastOwnOriginURL }
        diagnostics.log("retry", ["url": target.map(Diagnostics.redact) ?? ""])
        if webView.url == nil || lastLoadFailed || isHandoffURL(webView.url) || !(webView.url.map { self.config.isOwnOrigin($0) } ?? false) {
            load(target ?? config.baseURL)
        } else {
            lastLoadFailed = false
            armWatchdog(for: webView.url)
            webView.reload()
        }
    }

    /// Ends editing in the page: the keyboard goes before the shell moves somewhere else.
    func endEditing() {
        webView.endEditing(true)
        webView.evaluateJavaScript("(function(){var a=document.activeElement; if (a && a.blur) a.blur();})()", completionHandler: nil)
    }

    // MARK: - Drag down to put the keyboard away

    /// The scroll view's interactive dismissal (keyboardDismissMode) needs a page that pans, and the
    /// web app turns off overscroll in the shell, so a page that does not scroll (Home) would never
    /// let the keyboard go. This recognizer runs beside WebKit's own, as Messages behaves:
    /// - a drag whose finger reaches the keyboard's top edge puts the keyboard away;
    /// - a mostly downward drag of `dragDismissPoints` puts it away early only where nothing under
    ///   the finger can still scroll that way (the page is at its top and no scroller under the
    ///   finger has anything above), so rereading earlier messages keeps the keyboard;
    /// - a drag that starts in a field never does.
    static let dragDismissPoints: CGFloat = 40
    private var dragStart: CGPoint?
    private var dragHandled = false
    /// What is under the drag's start, read from the page when it begins (nil until it answers).
    private var dragOnEditable: Bool?
    private var dragOverScroller: Bool?
    /// The drag's last finger position (window) and movement, for a page that answers late.
    private var dragFinger: CGPoint = .zero
    private var dragMove: CGPoint = .zero
    /// Set by the shell from the keyboard notifications.
    var keyboardIsUp = false
    /// The keyboard's top edge in window coordinates while it is up.
    private var keyboardTop: CGFloat = 0
    private var keyboardObserver: NSObjectProtocol?

    private func installKeyboardDragDismiss() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(keyboardDrag(_:)))
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        pan.delegate = self
        webView.addGestureRecognizer(pan)
        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            self?.keyboardTop = frame.minY
        }
    }

    @objc private func keyboardDrag(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            let start = pan.location(in: webView)
            dragStart = start
            dragHandled = false
            dragOnEditable = nil
            dragOverScroller = nil
            // Nothing of the last drag carries over (a late answer must not read its finger).
            dragFinger = .zero
            dragMove = .zero
            guard keyboardIsUp else { return }
            // The start point in the page's layout viewport: the visual viewport may be scaled or
            // moved (WebKit shifts it while the keyboard is up).
            let script = """
            (function (x, y) {
              var v = window.visualViewport, s = v ? v.scale : 1;
              var e = document.elementFromPoint(x / s + (v ? v.offsetLeft : 0), y / s + (v ? v.offsetTop : 0));
              if (!e) return JSON.stringify({ editable: false, scroller: false });
              var editable = !!(e.closest && e.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
              var scroller = false;
              for (var n = e; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
                var cs = getComputedStyle(n);
                if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1 && n.scrollTop > 0) { scroller = true; break; }
              }
              return JSON.stringify({ editable: editable, scroller: scroller });
            })(\(Double(start.x)), \(Double(start.y)))
            """
            webView.evaluateJavaScript(script) { [weak self] result, _ in
                guard let self = self, let text = result as? String, let data = text.data(using: .utf8),
                      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Bool] else { return }
                self.dragOnEditable = object["editable"] ?? false
                self.dragOverScroller = object["scroller"] ?? false
                // A quick drag can end before the page answers.
                self.considerKeyboardDismiss()
            }
        case .changed, .ended:
            dragFinger = pan.location(in: nil)
            dragMove = pan.translation(in: webView)
            considerKeyboardDismiss()
        default:
            break
        }
    }

    private func considerKeyboardDismiss() {
            guard keyboardIsUp, !dragHandled, dragStart != nil, dragOnEditable == false else { return }
            let finger = dragFinger
            let move = dragMove
            let reachesKeyboard = keyboardTop > 0 && finger.y >= keyboardTop - 12
            let pageAtTop = webView.scrollView.contentOffset.y <= 0
            let early = move.y > WebController.dragDismissPoints && move.y > abs(move.x) * 1.5
                && pageAtTop && dragOverScroller == false
            guard reachesKeyboard || early else { return }
            dragHandled = true
            diagnostics.log("keyboard-drag", ["reachedKeyboard": reachesKeyboard, "early": early])
            endEditing()
    }

    // MARK: - Back

    /// What the left-edge swipe does now (from the page's last `route`: `ShellBack`).
    private(set) var backMode: ShellBack = .webHistory
    private var backSwipe: UIScreenEdgePanGestureRecognizer?
    /// The slide over the previous page's snapshot (BackTransition.swift).
    private(set) lazy var transition = BackTransition(webView: webView, diagnostics: diagnostics)
    /// The swipe in progress plays the slide.
    private var swipeSlides = false

    /// The page's last `route` said `canGoBack` (or nothing): WebKit's own back gesture for a page
    /// that keeps no stacks, the shell's own edge swipe sending `openbot:back` for one that does.
    func updateBack(canGoBack: Bool?, depth: Int? = nil, tab: String? = nil) {
        if let tab = tab { transition.route(tab: tab, depth: depth) }
        // The page has its new route: once it has drawn, a cover left by a back goes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.transition.pageDrawn() }
        let mode = ShellBack.decide(canGoBack: canGoBack)
        guard mode != backMode else { return }
        backMode = mode
        webView.allowsBackForwardNavigationGestures = mode.usesWebKitGesture
        backSwipe?.isEnabled = !mode.usesWebKitGesture
        diagnostics.log("back-mode", ["mode": "\(mode)"])
    }

    private func installBackSwipe() {
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleBackSwipe(_:)))
        edge.edges = .left
        edge.delegate = self
        edge.isEnabled = false
        webView.addGestureRecognizer(edge)
        backSwipe = edge
    }

    @objc private func handleBackSwipe(_ edge: UIScreenEdgePanGestureRecognizer) {
        let move = edge.translation(in: webView)
        let width = max(webView.bounds.width, 1)
        switch edge.state {
        case .began:
            swipeSlides = backMode == .sendToPage && transition.canSlide
            if swipeSlides { transition.begin() }
        case .changed:
            if swipeSlides { transition.update(progress: move.x / width) }
        case .ended:
            let velocity = edge.velocity(in: webView).x
            let through = move.x > width / 3 || (velocity > 500 && move.x > 30)
            diagnostics.log("back-swipe", ["mode": "\(backMode)", "slide": swipeSlides, "through": through])
            if swipeSlides {
                transition.end(through: through && backMode == .sendToPage) { [weak self] in self?.sendBack() }
            } else if backMode == .sendToPage, through, move.x > abs(move.y) * 1.5 {
                // No picture to slide over: the page changes when the swipe ends.
                sendBack()
            }
            swipeSlides = false
        case .cancelled, .failed:
            if swipeSlides { transition.end(through: false) {} }
            swipeSlides = false
        default:
            break
        }
    }

    /// The page asked to go somewhere in this tab (`will-navigate`): a picture first, or the slide
    /// for a back, then `openbot:navigate-ok` lets it go ahead (it waits 120 ms at most).
    private func willNavigate(_ body: [String: Any]) {
        let direction = body["direction"] as? String ?? ""
        let tab = body["tab"] as? String ?? transition.currentTab
        let ok = { [weak self] in
            self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent(\"openbot:navigate-ok\"))", completionHandler: nil)
        }
        switch direction {
        case "push": transition.willPush(tab: tab, completion: ok)
        case "back": transition.playBack(back: ok)
        default: ok()
        }
    }

    /// Asks the page to pop the current tab's stack (main frame, own origin only).
    func sendBack() {
        guard let url = webView.url, config.isOwnOrigin(url) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent(\"openbot:back\"))", completionHandler: nil)
    }

    func stop() {
        disarmWatchdog()
        webView.stopLoading()
    }

    /// The pathname the page is on, for coming back to it after a sign-in renewal.
    var currentPath: String {
        guard let url = webView.url, config.isOwnOrigin(url) else { return "/" }
        let path = url.path.isEmpty ? "/" : url.path
        return path.hasPrefix("/api/") ? "/" : path
    }

    /// Lets one hosted sign-in navigation through (the server has no hand-off) and loads it.
    func loadHostedSignInAfterAll(_ url: URL) {
        allowHostedOnce = url
        load(url)
    }

    /// Reads the page's background colour and whether it is dark. Calls back on the main queue.
    func readChrome(completion: @escaping (_ color: UIColor?, _ dark: Bool?, _ css: String) -> Void) {
        let script = """
        (function () {
          var b = document.body, h = document.documentElement;
          if (!b || !h) return null;
          var css = getComputedStyle(b).backgroundColor;
          if (!css || css === "transparent" || css === "rgba(0, 0, 0, 0)") css = getComputedStyle(h).backgroundColor;
          var canvas = document.createElement("canvas");
          canvas.width = 1; canvas.height = 1;
          var x = canvas.getContext("2d");
          x.fillStyle = "rgba(0,0,0,0)";
          x.fillStyle = css;
          x.fillRect(0, 0, 1, 1);
          var d = x.getImageData(0, 0, 1, 1).data;
          return JSON.stringify({ css: String(css), r: d[0], g: d[1], b: d[2], a: d[3], dark: h.classList.contains("dark") });
        })()
        """
        webView.evaluateJavaScript(script) { result, _ in
            guard let text = result as? String, let data = text.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                completion(nil, nil, "")
                return
            }
            let dark = object["dark"] as? Bool
            let css = object["css"] as? String ?? ""
            let alpha = (object["a"] as? NSNumber)?.doubleValue ?? 0
            guard alpha > 0,
                  let r = (object["r"] as? NSNumber)?.doubleValue,
                  let g = (object["g"] as? NSNumber)?.doubleValue,
                  let b = (object["b"] as? NSNumber)?.doubleValue else {
                completion(nil, dark, css)
                return
            }
            // An opaque colour: the strip behind the status bar must not let anything show through.
            completion(UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: 1), dark, css)
        }
    }

    // MARK: - Watchdog

    private func armWatchdog(for url: URL?) {
        watchdog?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.watchdog = nil
            self.diagnostics.log("load-watchdog", ["url": url.map(Diagnostics.redact) ?? "", "seconds": WebController.watchdogSeconds])
            self.webView.stopLoading()
            if let url = url, !self.config.isOwnOrigin(url) {
                self.leaveFailedOtherSite(url, why: "watchdog")
                return
            }
            self.lastLoadFailed = true
            self.delegate?.webController(self, didFailLoad: "OpenBot didn't answer. Try again in a moment.")
        }
        watchdog = item
        DispatchQueue.main.asyncAfter(deadline: .now() + WebController.watchdogSeconds, execute: item)
    }

    private func disarmWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    // MARK: - WKScriptMessageHandler (the page bridge)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let fromOwnOrigin = isOwnOrigin(origin)
        guard message.frameInfo.isMainFrame, fromOwnOrigin, let body = message.body as? [String: Any] else {
            diagnostics.log("bridge-rejected", ["mainFrame": message.frameInfo.isMainFrame, "host": origin.host])
            return
        }
        let type = body["type"] as? String ?? ""
        var entry: [String: Any] = ["type": type]
        if let path = body["path"] as? String { entry["path"] = path }
        if let tab = body["tab"] as? String { entry["tab"] = tab }
        if let signedIn = body["signedIn"] as? Bool { entry["signedIn"] = signedIn }
        diagnostics.log("bridge", entry)
        if type == "ready" { pageReady = true }
        if type == "will-navigate" { willNavigate(body) }
        delegate?.webController(self, didReceive: body)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        diagnostics.log("navigation-action", [
            "url": Diagnostics.redact(url),
            "mainFrame": isMainFrame,
            "targetFrameNil": navigationAction.targetFrame == nil,
            "type": navigationAction.navigationType.rawValue,
        ])
        // The sign-in callback is only ever taken from the sheet the app started.
        if scheme == "openbotshell" {
            diagnostics.log("callback-scheme-refused", [:])
            decisionHandler(.cancel)
            return
        }
        // Signed in, back and forward stay on the web app's own pages and never reach the sign-in
        // page: walking back after a web sign-in would go through the identity provider to /sign.
        if signedIn, navigationAction.navigationType == .backForward, isMainFrame,
           !config.isOwnOrigin(url) || url.path == "/sign" || url.path.hasPrefix("/sign/") || url.path.hasPrefix("/api/auth/") {
            diagnostics.log("back-forward-refused", ["ownOrigin": config.isOwnOrigin(url)])
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            // Files only from the web app's own page; another site's or a frame's go nowhere.
            let allowed = isMainFrame && config.isOwnOrigin(url)
            diagnostics.log("download-request", ["allowed": allowed])
            decisionHandler(allowed ? .download : .cancel)
            return
        }
        if scheme == "http" || scheme == "https" {
            if isMainFrame, config.isOwnOrigin(url), url.path == "/api/auth/hosted/sign-in" {
                if let allowed = allowHostedOnce, allowed == url {
                    allowHostedOnce = nil
                } else if delegate?.webController(self, shouldInterceptHostedSignIn: url) == true {
                    diagnostics.log("hosted-sign-in-intercepted", [:])
                    decisionHandler(.cancel)
                    return
                }
            }
            let leavesOrigin = isMainFrame && !config.isOwnOrigin(url)
            if leavesOrigin, navigationAction.navigationType == .linkActivated,
               delegate?.webControllerAllowsLeavingOrigin(self) != true {
                diagnostics.log("open-in-safari", ["url": Diagnostics.redact(url)])
                presentSafari(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if ["about", "data", "blob", "javascript"].contains(scheme) {
            decisionHandler(.allow)
            return
        }
        openExternal(url, mainFrame: isMainFrame, tapped: navigationAction.navigationType == .linkActivated)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if diagnostics.enabled, let http = navigationResponse.response as? HTTPURLResponse {
            var entry: [String: Any] = [
                "url": http.url.map(Diagnostics.redact) ?? "",
                "mainFrame": navigationResponse.isForMainFrame,
                "status": http.statusCode,
                "mimeType": http.mimeType ?? "",
            ]
            let headerNames = [
                "content-security-policy",
                "x-frame-options",
                "access-control-allow-origin",
                "access-control-allow-credentials",
                "strict-transport-security",
            ]
            var headers: [String: String] = [:]
            for name in headerNames {
                if let value = http.value(forHTTPHeaderField: name) {
                    headers[name] = value
                }
            }
            entry["headers"] = headers
            // Names only, never values.
            var fields: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { fields[key] = value }
            }
            if let url = http.url {
                entry["setCookieNames"] = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).map { $0.name }
            }
            diagnostics.log("navigation-response", entry)
        }
        let http = navigationResponse.response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if disposition.hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            // A file: never in place of the app's page. From the web app's own main frame it is saved
            // and handed to the share sheet; from anywhere else it is dropped.
            let fromApp = navigationResponse.isForMainFrame && (navigationResponse.response.url.map { config.isOwnOrigin($0) } ?? false)
            diagnostics.log("download-response", ["mimeType": http?.mimeType ?? navigationResponse.response.mimeType ?? "", "allowed": fromApp])
            decisionHandler(fromApp ? .download : .cancel)
            return
        }
        if navigationResponse.isForMainFrame, let http = http, http.statusCode >= 500,
           let url = http.url, config.isOwnOrigin(url) {
            // The web app's own server failed: the lock screen and its retry, not the raw error page.
            diagnostics.log("server-error", ["status": http.statusCode, "url": Diagnostics.redact(url)])
            disarmWatchdog()
            lastLoadFailed = true
            decisionHandler(.cancel)
            delegate?.webController(self, didFailLoad: "server-error")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// Whether the navigation in progress has committed: until it does, the last page is still on
    /// screen, intact.
    private var committedSinceStart = true

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        committedSinceStart = false
        if let url = webView.url, url.absoluteString != "about:blank" {
            if !isHandoffURL(url) { lastRequestedURL = url }
            diagnostics.log("main-frame-start", ["url": Diagnostics.redact(url)])
        }
        armWatchdog(for: webView.url)
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        guard let url = webView.url else { return }
        diagnostics.log("server-redirect", ["url": Diagnostics.redact(url)])
        if !isHandoffURL(url), url.absoluteString != "about:blank" { lastRequestedURL = url }
        armWatchdog(for: url)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committedSinceStart = true
        disarmWatchdog()
        hideKeyboardAccessory(when: "commit")
        // WebKit commits about:blank in place of a load it refuses without an error (a restricted
        // port, seen in CI): that is a failed load.
        if webView.url?.absoluteString == "about:blank", blankDone == nil,
           let requested = lastRequestedURL, ["http", "https"].contains(requested.scheme?.lowercased() ?? "") {
            diagnostics.log("blocked-load", ["url": Diagnostics.redact(requested)])
            if !config.isOwnOrigin(requested) {
                leaveFailedOtherSite(requested, why: "blocked")
                return
            }
            lastLoadFailed = true
            delegate?.webController(self, didFailLoad: "blocked")
            return
        }
        pageReady = false
        lastLoadFailed = false
        if let url = webView.url, config.isOwnOrigin(url), !isHandoffURL(url) { lastOwnOriginURL = url }
        diagnostics.log("main-frame-commit", ["url": webView.url.map(Diagnostics.redact) ?? ""])
        delegate?.webControllerDidCommit(self)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        disarmWatchdog()
        if let blank = blankDone, webView.url == nil || webView.url?.absoluteString == "about:blank" {
            blankDone = nil
            blank()
            return
        }
        delegate?.webControllerDidFinish(self)
        diagnostics.log("did-finish", ["url": webView.url.map(Diagnostics.redact) ?? ""])
        guard diagnostics.enabled else { return }
        takeSnapshot(reason: "didFinish")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.takeSnapshot(reason: "didFinish+5s")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handle(error, phase: "didFail")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handle(error, phase: "didFailProvisionalNavigation")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagnostics.log("content-process-terminated", [:])
        hideKeyboardAccessory(when: "process-terminated")
        delegate?.webControllerContentProcessRestarted(self)
        if webView.url == nil || isHandoffURL(webView.url) {
            load(lastRequestedURL ?? lastOwnOriginURL ?? config.baseURL)
        } else {
            armWatchdog(for: webView.url)
            webView.reload()
        }
    }

    private func handle(_ error: Error, phase: String) {
        disarmWatchdog()
        let nsError = error as NSError
        let failingURL = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL).map(Diagnostics.redact) ?? ""
        diagnostics.log("navigation-error", [
            "phase": phase,
            "domain": nsError.domain,
            "code": nsError.code,
            "description": nsError.localizedDescription,
            "url": failingURL,
        ])
        // A cancelled load is a new navigation replacing the old one, not a failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        // WebKit reports "frame load interrupted" (102) when a download or policy change stops a
        // load; that is not something to show either.
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        // Another site's page (an identity provider or a vendor blocked on this network): back to the
        // web app's last page, which carries on. Only the web app's own pages lock the app.
        if let failing = nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL,
           ["http", "https"].contains(failing.scheme?.lowercased() ?? ""), !config.isOwnOrigin(failing) {
            leaveFailedOtherSite(failing, why: phase)
            return
        }
        lastLoadFailed = true
        delegate?.webController(self, didFailLoad: nsError.localizedDescription)
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let sameOrigin = config.isOwnOrigin(url)
        diagnostics.log("create-web-view", ["url": Diagnostics.redact(url), "sameHost": sameOrigin])
        let scheme = url.scheme?.lowercased() ?? ""
        if sameOrigin {
            // Same-origin popups replace the current page: the shell has one web view.
            webView.load(navigationAction.request)
        } else if scheme == "http" || scheme == "https" {
            // Other sites open in an in-app Safari sheet.
            presentSafari(url)
        } else if scheme != "openbotshell" {
            openExternal(url, mainFrame: true, tapped: navigationAction.navigationType == .linkActivated)
        }
        return nil
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        diagnostics.log("js-alert", ["ownOrigin": isOwnOrigin(frame)])
        guard isOwnOrigin(frame), let presenter = topViewController() else {
            completionHandler()
            return
        }
        let alert = UIAlertController(title: "OpenBot", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        diagnostics.log("js-confirm", ["ownOrigin": isOwnOrigin(frame)])
        guard isOwnOrigin(frame), let presenter = topViewController() else {
            completionHandler(false)
            return
        }
        let alert = UIAlertController(title: "OpenBot", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        diagnostics.log("js-prompt", ["ownOrigin": isOwnOrigin(frame)])
        guard isOwnOrigin(frame), let presenter = topViewController() else {
            completionHandler(nil)
            return
        }
        let alert = UIAlertController(title: "OpenBot", message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Only the OpenBot origin may use the microphone and camera; iOS still asks the person.
        let granted = isOwnOrigin(origin)
        diagnostics.log("media-permission", [
            "origin": "\(origin.protocol)://\(origin.host):\(origin.port)",
            "type": type.rawValue,
            "granted": granted,
        ])
        decisionHandler(granted ? .grant : .deny)
    }

    // MARK: - Helpers

    /// A JavaScript dialog's frame is on the web app's own origin (other sites' dialogs are dropped).
    private func isOwnOrigin(_ frame: WKFrameInfo) -> Bool {
        isOwnOrigin(frame.securityOrigin)
    }

    /// Scheme, host and port, as an origin is compared (another port on the same host is another
    /// site: the probe's two origins differ only by port).
    private func isOwnOrigin(_ origin: WKSecurityOrigin) -> Bool {
        let scheme = origin.protocol.lowercased()
        guard scheme == (config.baseURL.scheme ?? "").lowercased(), origin.host.lowercased() == config.baseHost else { return false }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = origin.port == 0 ? defaultPort : origin.port
        return port == (config.baseURL.port ?? defaultPort)
    }

    /// Schemes handed to the system, only from a tap in the main frame.
    static let externalSchemes: Set<String> = ["mailto", "tel", "sms"]

    private func openExternal(_ url: URL, mainFrame: Bool, tapped: Bool) {
        let scheme = url.scheme?.lowercased() ?? ""
        guard mainFrame, tapped, WebController.externalSchemes.contains(scheme) else {
            diagnostics.log("external-dropped", ["scheme": scheme, "mainFrame": mainFrame, "tapped": tapped])
            return
        }
        diagnostics.log("open-external", ["scheme": scheme])
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    /// Another site's page did not load: back to the web app's last page, without the lock screen.
    private func leaveFailedOtherSite(_ url: URL, why: String) {
        // A load that never committed left the last page as it was (an open conversation, say):
        // nothing to reload. Only a page that is gone (a blocked load put about:blank in its place,
        // or another site's page is what is showing) sends the web view back.
        let pageIntact = !committedSinceStart && (webView.backForwardList.currentItem.map { config.isOwnOrigin($0.url) } ?? false)
        diagnostics.log("other-site-failed", ["host": url.host ?? "", "why": why, "pageIntact": pageIntact])
        lastLoadFailed = false
        delegate?.webController(self, otherSiteFailed: url)
        if pageIntact {
            committedSinceStart = true
            return
        }
        load(lastOwnOriginURL ?? config.baseURL)
    }

    private var lastAccessoryResult = ""

    /// The form-assistant bar is hidden by swapping a private WebKit class at run time
    /// (KeyboardAccessory.swift). Info.plist's `OpenBotHideKeyboardAccessory` (project.yml) turns that
    /// off without a code change, should App Review object: the bar then comes back.
    static let hidesKeyboardAccessory = (Bundle.main.object(forInfoDictionaryKey: "OpenBotHideKeyboardAccessory") as? Bool) ?? true

    private func hideKeyboardAccessory(when: String) {
        guard WebController.hidesKeyboardAccessory else {
            if lastAccessoryResult != "off" {
                lastAccessoryResult = "off"
                diagnostics.log("keyboard-accessory", ["result": "switched off in Info.plist", "when": when])
            }
            return
        }
        let result = KeyboardAccessory.hide(in: webView)
        if result != lastAccessoryResult {
            lastAccessoryResult = result
            diagnostics.log("keyboard-accessory", ["result": result, "when": when])
        }
    }

    private func presentSafari(_ url: URL) {
        guard let presenter = topViewController() else { return }
        presenter.present(SFSafariViewController(url: url), animated: true)
    }

    private func topViewController() -> UIViewController? {
        var controller = webView.window?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        return controller
    }

    private func takeSnapshot(reason: String) {
        let insets = webView.safeAreaInsets
        let native: [String: Any] = [
            "top": Double(insets.top),
            "right": Double(insets.right),
            "bottom": Double(insets.bottom),
            "left": Double(insets.left),
            "webViewHeight": Double(webView.bounds.height),
            "webViewMinY": Double(webView.convert(webView.bounds, to: nil).minY),
        ]
        webView.evaluateJavaScript(Diagnostics.snapshotScript) { [weak self] result, error in
            guard let self = self else { return }
            var entry: [String: Any] = ["reason": reason, "native": native]
            if let text = result as? String, let data = text.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) {
                entry["page"] = object
            } else if let error = error {
                entry["error"] = error.localizedDescription
            }
            self.diagnostics.log("snapshot", entry)
        }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            // Names and attributes only, never values.
            let list: [[String: Any]] = cookies.map { cookie in
                [
                    "name": cookie.name,
                    "domain": cookie.domain,
                    "path": cookie.path,
                    "isSecure": cookie.isSecure,
                    "isHTTPOnly": cookie.isHTTPOnly,
                    "isSessionOnly": cookie.isSessionOnly,
                    "sameSite": cookie.sameSitePolicy?.rawValue ?? "unspecified",
                ]
            }
            self?.diagnostics.log("cookie-store", ["reason": reason, "cookies": list])
        }
    }
}

/// Holds the bridge's real handler weakly, so the web view's content controller does not keep the
/// WebController alive.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

extension WebController: UIGestureRecognizerDelegate {
    /// Beside WebKit's own recognizers: the drag still scrolls the page and taps still land.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

extension WebController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let file = folder.appendingPathComponent(name)
        downloadFiles[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
        diagnostics.log("download-finished", ["bytes": (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1])
        guard let presenter = topViewController() else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        // The file's folder goes when the share sheet closes, whatever the person chose.
        sheet.completionWithItemsHandler = { [weak self] _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            self?.diagnostics.log("download-cleaned", [:])
        }
        sheet.popoverPresentationController?.sourceView = webView
        sheet.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
        presenter.present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        diagnostics.log("download-failed", ["description": (error as NSError).localizedDescription])
    }
}
