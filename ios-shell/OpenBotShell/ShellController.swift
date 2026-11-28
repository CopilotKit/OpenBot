import Foundation
import UIKit
import WebKit

/// Runs the app: decides signed in or not at launch, drives sign-in, routes tab taps to the page,
/// listens to the page, watches the network and the keyboard. The views draw `model`.
final class ShellController: NSObject, WebControllerDelegate {
    let config: ShellConfig
    let diagnostics: Diagnostics
    let model: AppModel
    let web: WebController

    private let signInFlow: SignInFlow
    private let network = NetworkMonitor()
    private var started = false
    /// What the server's hand-off config last said: the sheet's callback, or nil (unknown, or none).
    private var handoffMode: HandoffMode?
    private var handoffSupported: Bool? {
        switch handoffMode {
        case .none: return nil
        case .some(.scheme), .some(.https): return true
        default: return false
        }
    }
    /// A sign-in renewal (hosted sign-in intercepted while signed in) is running.
    private var renewing = false
    /// Gives up on an enter URL that never leads to a signed-in page.
    private var enterTimeout: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    /// What failed while the lock is up for a load failure: the web view, or a sign-in step.
    private enum FailureSource { case web, signIn }
    private var failureSource: FailureSource?
    private var autoRetry: DispatchWorkItem?
    private var retryCount = 0

    private var cookieStore: WKHTTPCookieStore { web.webView.configuration.websiteDataStore.httpCookieStore }

    init(config: ShellConfig) {
        self.config = config
        let diagnostics = Diagnostics(enabled: config.diagnosticsEnabled, testName: config.testName)
        self.diagnostics = diagnostics
        model = AppModel(diagnostics: diagnostics)
        web = WebController(config: config, diagnostics: diagnostics)
        signInFlow = SignInFlow(diagnostics: diagnostics)
        super.init()
        web.delegate = self
        if config.plainWebView { model.phase = .plain }
        diagnostics.log("launch", [
            "baseURL": Diagnostics.redact(config.baseURL),
            "version": config.version,
            "systemVersion": UIDevice.current.systemVersion,
            "model": UIDevice.current.model,
            "plain": config.plainWebView,
            "ephemeralSignIn": config.ephemeralSignIn,
        ])
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func start(window: UIWindow) {
        guard !started else { return }
        started = true
        signInFlow.window = window

        network.onChange = { [weak self] offline in self?.networkChanged(offline: offline) }
        network.start(forceOffline: config.forceOffline, forceOfflineSeconds: config.forceOfflineSeconds)
        observeKeyboard()

        if config.plainWebView {
            web.load(config.startURL ?? config.baseURL)
            return
        }
        prepareDataStore { [weak self] in self?.decideLaunchState() }
    }

    // MARK: - Launch

    /// DEBUG hooks that change the cookie store before anything looks at it.
    private func prepareDataStore(_ done: @escaping () -> Void) {
        var steps: [(@escaping () -> Void) -> Void] = []
        #if DEBUG
        if config.resetDataStore {
            steps.append { [weak self] next in
                let store = WKWebsiteDataStore.default()
                store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                    self?.diagnostics.log("test-hook", ["hook": "reset-data-store"])
                    DispatchQueue.main.async { next() }
                }
            }
        }
        if let value = config.testSessionCookie {
            steps.append { [weak self] next in
                guard let self = self else { return }
                SessionCookies.set(name: SessionCookies.secureName, value: value, secure: true,
                                   host: self.config.baseHost, in: self.cookieStore) { ok in
                    self.diagnostics.log("test-hook", ["hook": "test-session-cookie", "ok": ok])
                    next()
                }
            }
        }
        if let value = config.testPlainSessionCookie {
            steps.append { [weak self] next in
                guard let self = self else { return }
                SessionCookies.set(name: SessionCookies.plainName, value: value, secure: false,
                                   host: self.config.baseHost, in: self.cookieStore) { ok in
                    self.diagnostics.log("test-hook", ["hook": "plain-session-cookie", "ok": ok])
                    next()
                }
            }
        }
        if config.staleSessionCookie {
            steps.append { [weak self] next in
                guard let self = self else { return }
                SessionCookies.set(name: SessionCookies.plainName, value: "stale", secure: false,
                                   host: self.config.baseHost, in: self.cookieStore) { ok in
                    self.diagnostics.log("test-hook", ["hook": "stale-session-cookie", "ok": ok])
                    next()
                }
            }
        }
        #endif
        func run(_ index: Int) {
            if index >= steps.count {
                done()
                return
            }
            let step = steps[index]
            step { run(index + 1) }
        }
        run(0)
    }

    /// Start WebKit locally before asking for its saved cookies. On a cold launch a read made
    /// before the web process is ready can time out, delaying the sign-in screen by five seconds.
    private func decideLaunchState() {
        web.loadBlank { [weak self] in
            guard let self else { return }
            SessionCookies.present(in: self.cookieStore, host: self.config.baseHost) { [weak self] present, timedOut in
                guard let self else { return }
                self.diagnostics.log("session-cookie", ["present": present, "timedOut": timedOut])
                if present { self.launchSignedIn() } else { self.model.phase = .signedOut }
            }
        }
    }

    private func launchSignedIn() {
        beginPageLoad("launch")
        model.phase = .signedIn
        #if DEBUG
        if let delay = config.delayFirstLoadSeconds {
            diagnostics.log("test-hook", ["hook": "delay-first-load", "seconds": delay])
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.web.load(path: "/") }
            return
        }
        #endif
        web.load(path: "/")
    }

    // MARK: - The loading skeleton

    private var loadingSince: Date?
    private var loadingCheck: DispatchWorkItem?

    /// A main-frame page starts loading: the skeleton covers the web view until it has drawn.
    private func beginPageLoad(_ reason: String) {
        loadingSince = Date()
        loadingCheck?.cancel()
        diagnostics.log("page-load-begin", ["reason": reason])
        model.pageLoading = true
    }

    /// The page has drawn (its `ready`, or content after didFinish): the skeleton fades out, after
    /// at least 0.3 s so it never flashes.
    private func endPageLoad(_ reason: String) {
        guard model.pageLoading else { return }
        loadingCheck?.cancel()
        let shown = Date().timeIntervalSince(loadingSince ?? .distantPast)
        let wait = max(0, 0.3 - shown)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self = self, self.model.pageLoading else { return }
            self.diagnostics.log("page-load-end", ["reason": reason, "ms": Int(Date().timeIntervalSince(self.loadingSince ?? Date()) * 1000)])
            self.model.pageLoading = false
        }
    }

    /// After didFinish, without a `ready` (an older web app): ends the skeleton once the document is
    /// complete and the body has something in it, checking a few times.
    private func checkPageDrawn(attempt: Int = 0) {
        guard model.pageLoading else { return }
        // Drawn: the document is complete and at least three pieces of text are really on screen:
        // inside the viewport, not hidden, not faded out, more than 4 px (screen-reader-only text
        // measures 1 px).
        let script = """
        (function () {
          if (document.readyState !== 'complete' || !document.body) return false;
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          var seen = 0, node, range = document.createRange();
          while ((node = walker.nextNode()) && seen < 3) {
            if (!node.textContent.trim()) continue;
            range.selectNodeContents(node);
            var r = range.getBoundingClientRect();
            if (!(r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) continue;
            // Not faded out (a page's intro animation starts at opacity 0) and not hidden.
            var el = node.parentElement, visible = true, opacity = 1;
            while (el && el !== document.documentElement) {
              var cs = getComputedStyle(el);
              if (cs.visibility === 'hidden' || cs.display === 'none') { visible = false; break; }
              opacity *= parseFloat(cs.opacity || '1');
              el = el.parentElement;
            }
            if (visible && opacity > 0.5) seen++;
          }
          return seen >= 3;
        })()
        """
        web.webView.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self = self else { return }
            if (result as? Bool) == true {
                self.endPageLoad("drawn")
            } else if attempt >= 20 {
                self.endPageLoad("no-content-after-8s")
            } else {
                let item = DispatchWorkItem { [weak self] in self?.checkPageDrawn(attempt: attempt + 1) }
                self.loadingCheck = item
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
            }
        }
    }

    func layoutChanged(tabBarHeight: CGFloat, webFrame: CGRect) {
        if model.webFrame != webFrame { model.webFrame = webFrame }
        diagnostics.log("layout", [
            "tabBarHeight": Double(tabBarHeight),
            "webTop": Double(webFrame.minY), "webBottom": Double(webFrame.maxY),
        ])
    }

    // MARK: - Sign in

    /// The native Sign in button.
    func signIn() {
        guard model.phase == .signedOut, model.signIn == .idle else { return }
        model.signInMessage = nil
        #if DEBUG
        if let url = config.debugSheetURL {
            // A test opens an arbitrary page in the sheet to see what it does there.
            model.signIn = .sheet
            signInFlow.presentSheet(url, mode: .scheme, ephemeral: true) { [weak self] outcome in
                guard let self = self else { return }
                let name: String
                switch outcome {
                case .ticket: name = "ticket"
                case .cancelled: name = "cancelled"
                case .failed(let reason): name = "failed " + reason
                }
                self.diagnostics.log("debug-sheet-finished", ["outcome": name])
                self.model.signIn = .idle
            }
            return
        }
        #endif
        let pair = PKCEPair.make()
        model.signIn = .probing
        signInFlow.fetchConfig(base: config.baseURL, baseHost: config.baseHost) { [weak self] mode in
            guard let self = self, self.model.signIn == .probing else { return }
            switch mode {
            case .unreachable:
                // No answer at all: the lock screen, not the web sign-in.
                self.model.signIn = .idle
                self.showLoadFailure(.signIn, detail: "handoff-config-no-answer")
            case .webSignIn:
                self.handoffMode = mode
                self.startWebSignIn()
            case .scheme, .https:
                self.handoffMode = mode
                self.presentSheet(pair: pair, mode: mode, returnTo: "/")
            }
        }
    }

    /// The web sign-in fallback's Cancel.
    func cancelWebSignIn() {
        guard model.signIn == .webFallback else { return }
        web.stop()
        clearLoadFailure()
        model.signIn = .idle
    }

    private func handoffURL(challenge: String) -> URL {
        var query = "challenge=\(challenge)&platform=ios"
        #if DEBUG
        if config.handoffAuto { query += "&auto=1" }
        #endif
        return config.url("/api/auth/shell/handoff?" + query)
    }

    private func enterURL(ticket: String, verifier: String, to path: String) -> URL {
        var components = URLComponents(url: config.url("/api/auth/shell/enter"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "ticket", value: ticket),
            URLQueryItem(name: "verifier", value: verifier),
            URLQueryItem(name: "to", value: path),
        ]
        // URLComponents leaves "+" alone in query values; a server reads it as a space.
        let encoded = components?.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        components?.percentEncodedQuery = encoded
        return components?.url ?? config.url("/sign?native-sign-in=failed")
    }

    private func presentSheet(pair: PKCEPair, mode: HandoffMode, returnTo: String) {
        if !renewing { model.signIn = .sheet }
        signInFlow.presentSheet(handoffURL(challenge: pair.challenge), mode: mode, ephemeral: config.ephemeralSignIn) { [weak self] outcome in
            guard let self = self else { return }
            switch outcome {
            case .ticket(let ticket):
                self.enter(ticket: ticket, verifier: pair.verifier, to: returnTo)
            case .cancelled:
                if self.renewing {
                    self.renewing = false
                } else {
                    self.model.signIn = .idle
                }
            case .failed(let reason):
                if self.renewing {
                    self.renewing = false
                } else if reason == "could not start" || reason.hasPrefix("https callback") {
                    // The sheet could not open (or cannot take an https callback here): the web sign-in.
                    self.model.signIn = .idle
                    self.startWebSignIn()
                } else {
                    self.model.signIn = .idle
                    self.model.signInMessage = "Sign-in didn't finish. Try again."
                }
            }
        }
    }

    private func enter(ticket: String, verifier: String, to path: String) {
        if !renewing {
            // In this same turn: the signed-in container with the skeleton already on it, so no
            // frame shows an empty web view or the sign-in screen between the sheet and the page.
            beginPageLoad("enter")
            model.signIn = .entering
            model.phase = .signedIn
        }
        diagnostics.log("enter", ["to": path, "renewal": renewing])
        enterTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.diagnostics.log("enter-timeout", ["seconds": SignInFlow.timeoutSeconds])
            self.failSignIn("Sign-in took too long. Try again.")
        }
        enterTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + SignInFlow.timeoutSeconds, execute: timeout)
        web.load(enterURL(ticket: ticket, verifier: verifier, to: path))
    }

    private func startWebSignIn() {
        model.signIn = .webFallback
        beginPageLoad("web-sign-in")
        web.load(path: "/sign?native-sign-in=web")
    }

    private func finishSignIn() {
        enterTimeout?.cancel()
        enterTimeout = nil
        renewing = false
        model.signIn = .idle
        model.signInMessage = nil
        clearLoadFailure()
        model.phase = .signedIn
    }

    private func failSignIn(_ message: String) {
        enterTimeout?.cancel()
        enterTimeout = nil
        if renewing {
            renewing = false
            return
        }
        guard model.signIn == .entering else { return }
        web.endEditing()
        web.stop()
        model.pageLoading = false
        model.phase = .signedOut
        model.signIn = .idle
        model.signInMessage = message
    }

    /// The page says nobody is signed in any more.
    private func sessionEnded(reason: String) {
        diagnostics.log("session-ended", ["reason": reason])
        web.endEditing()
        model.pageLoading = false
        enterTimeout?.cancel()
        renewing = false
        model.phase = .signedOut
        model.signIn = .idle
        clearLoadFailure()
        model.selectedTab = .home
        SessionCookies.delete(in: cookieStore, host: config.baseHost) { [weak self] deleted in
            self?.diagnostics.log("session-cookies-deleted", ["count": deleted])
        }
    }

    // MARK: - Tabs

    func selectTab(_ tab: ShellTab) {
        web.endEditing()
        model.selectedTab = tab
        web.open(path: tab.path) { [weak self] mode in
            self?.model.lastNavigation = mode
        }
    }

    // MARK: - Chrome colours

    func refreshChrome() {
        guard model.webVisible else { return }
        web.readChrome { [weak self] color, dark, css in
            guard let self = self else { return }
            if let color = color {
                self.model.pageBackground = color
                // A drag past the page's edge shows the page's own colour.
                self.web.webView.underPageBackgroundColor = color
            }
            if let dark = dark { self.model.pageIsDark = dark }
            self.diagnostics.log("chrome", ["css": css, "dark": dark.map { $0 ? 1 : 0 } ?? -1])
        }
    }

    // MARK: - Network and keyboard

    private func networkChanged(offline: Bool) {
        diagnostics.log("network", ["offline": offline, "reason": network.lastReason])
        model.offline = offline
        guard !offline else {
            web.endEditing()
            return
        }
        if model.loadFailed {
            retryNow()
        } else if model.webVisible, web.lastLoadFailed {
            web.retry()
        }
    }

    // MARK: - Load failures

    /// Any failure to load the web app shows the lock screen and retries by itself: every 5 s, then
    /// every 15 s after 6 tries, and when the network comes back. It lifts when a page commits.
    private func showLoadFailure(_ source: FailureSource, detail: String) {
        diagnostics.log("load-failure-lock", ["source": source == .web ? "web" : "sign-in", "detail": detail])
        web.endEditing()
        model.pageLoading = false
        failureSource = source
        model.loadFailed = true
        scheduleAutoRetry()
    }

    private func clearLoadFailure() {
        autoRetry?.cancel()
        autoRetry = nil
        retryCount = 0
        failureSource = nil
        model.loadFailed = false
    }

    private func scheduleAutoRetry() {
        autoRetry?.cancel()
        let delay: TimeInterval = retryCount < 6 ? 5 : 15
        let item = DispatchWorkItem { [weak self] in self?.retryNow(automatic: true) }
        autoRetry = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// The lock screen's Try again, and the automatic retries.
    func retryNow(automatic: Bool = false) {
        guard model.loadFailed else { return }
        retryCount += 1
        diagnostics.log("retry", ["automatic": automatic, "count": retryCount, "offline": model.offline])
        if !model.offline {
            switch failureSource {
            case .some(.signIn):
                // Nothing to reload: once OpenBot answers, back to the sign-in screen.
                signInFlow.ping(config.baseURL) { [weak self] answered in
                    guard let self = self else { return }
                    self.diagnostics.log("retry-ping", ["answered": answered])
                    if answered, self.failureSource == .some(.signIn) { self.clearLoadFailure() }
                }
            default:
                beginPageLoad("retry")
                web.retry()
            }
        }
        if model.loadFailed { scheduleAutoRetry() }
    }

    private func observeKeyboard() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            self?.model.keyboardVisible = true
        })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.model.keyboardVisible = false
        })
        // Leaving the app ends editing: no keyboard waiting over a page on the way back.
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.web.endEditing()
        })
    }

    // MARK: - WebControllerDelegate

    func webController(_ controller: WebController, didReceive message: [String: Any]) {
        let type = message["type"] as? String ?? ""
        switch type {
        case "ready":
            endPageLoad("ready")
            refreshChrome()
        case "route":
            let path = message["path"] as? String ?? ""
            let signedIn = message["signedIn"] as? Bool ?? false
            if let raw = message["tab"] as? String, let tab = ShellTab(rawValue: raw) {
                model.selectedTab = tab
            }
            if signedIn {
                if model.phase != .signedIn || renewing || model.signIn == .entering { finishSignIn() }
            } else if path == "/sign" || path.hasPrefix("/sign/") {
                if model.signIn == .entering {
                    failSignIn("Sign-in didn't finish. Try again.")
                } else if model.phase == .signedIn {
                    sessionEnded(reason: "route-sign")
                }
            }
            refreshChrome()
        case "signed-out":
            if model.signIn == .entering {
                failSignIn("Sign-in didn't finish. Try again.")
            } else if model.phase == .signedIn {
                sessionEnded(reason: "signed-out")
            }
        default:
            break
        }
    }

    func webController(_ controller: WebController, shouldInterceptHostedSignIn url: URL) -> Bool {
        guard model.phase == .signedIn, !renewing else { return false }
        if handoffSupported == false { return false }
        // The hosted sign-in's hourly renewal: do it in the system sheet, then come back here.
        renewing = true
        let returnTo = web.currentPath
        let pair = PKCEPair.make()
        diagnostics.log("renewal", ["returnTo": returnTo, "handoffKnown": handoffSupported != nil])
        if let mode = handoffMode, handoffSupported == true {
            presentSheet(pair: pair, mode: mode, returnTo: returnTo)
            return true
        }
        signInFlow.fetchConfig(base: config.baseURL, baseHost: config.baseHost) { [weak self] mode in
            guard let self = self else { return }
            switch mode {
            case .scheme, .https:
                self.handoffMode = mode
                self.presentSheet(pair: pair, mode: mode, returnTo: returnTo)
            case .webSignIn, .unreachable:
                if case .webSignIn = mode { self.handoffMode = mode }
                self.renewing = false
                self.web.loadHostedSignInAfterAll(url)
            }
        }
        return true
    }

    func webControllerAllowsLeavingOrigin(_ controller: WebController) -> Bool {
        model.signIn == .webFallback
    }

    func webController(_ controller: WebController, didFailLoad message: String) {
        // The error's own words stay in diagnostics (WebController logged them).
        if model.signIn == .entering {
            failSignIn("Sign-in didn't finish. Try again.")
            showLoadFailure(.signIn, detail: "enter-failed")
            return
        }
        guard model.webVisible else { return }
        if model.loadFailed, failureSource == .some(.web) { return }
        showLoadFailure(.web, detail: "web-load-failed")
    }

    func webController(_ controller: WebController, didChangeURL url: URL?) {
        guard let url = url, config.isOwnOrigin(url) else { return }
        let path = url.path.isEmpty ? "/" : url.path
        let first = path.split(separator: "/").first.map { "/" + $0 } ?? "/"
        if model.webPathRoot != first { model.webPathRoot = first }
        let onSignPage = path == "/sign" || path.hasPrefix("/sign/")
        // A web app without the bridge (production today) says nothing: its URL tells.
        if model.signIn == .entering, onSignPage {
            failSignIn("Sign-in didn't finish. Try again.")
        } else if model.phase == .signedIn, onSignPage, !renewing {
            sessionEnded(reason: "url-sign")
        } else if model.phase == .signedOut, model.signIn == .webFallback, !onSignPage, !path.hasPrefix("/api/") {
            SessionCookies.present(in: cookieStore, host: config.baseHost) { [weak self] present, _ in
                guard let self = self, present, self.model.signIn == .webFallback else { return }
                self.diagnostics.log("signed-in-by-url", ["pathRoot": first])
                self.beginPageLoad("signed-in-by-url")
                self.finishSignIn()
                self.checkPageDrawn()
            }
        }
    }

    func webControllerDidFinish(_ controller: WebController) {
        // An older web app says nothing over the bridge: read its colours when it has loaded.
        refreshChrome()
        if let url = controller.webView.url, config.isOwnOrigin(url) {
            // Without a `ready` (a Cloudflare check, an intermediary's error page, a web app without
            // the bridge): as soon as the page shows text, or after 8 s at most.
            checkPageDrawn()
        } else if model.signIn == .webFallback {
            // The identity provider's page: the skeleton until it shows text.
            checkPageDrawn()
        }
    }

    func webControllerContentProcessRestarted(_ controller: WebController) {
        if model.webVisible { beginPageLoad("content-process") }
    }

    func webControllerDidCommit(_ controller: WebController) {
        model.mainFrameCommits += 1
        // Every new document on the web app's origin starts empty: the skeleton covers it until it draws.
        // In the web sign-in, any site's new document (an identity provider's redirects) too.
        if model.webVisible, let url = controller.webView.url, url.absoluteString != "about:blank",
           config.isOwnOrigin(url) || model.signIn == .webFallback, !model.pageLoading {
            beginPageLoad("commit")
        }
        if failureSource == .some(.web) || failureSource == nil { clearLoadFailure() }
    }
}
