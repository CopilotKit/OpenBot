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

    /// Signed in when the session cookie is in the store. WebKit can answer "no cookies" at a cold
    /// launch before it has read its saved cookies (seen in CI): a "no" is asked again after the web
    /// view has loaded about:blank, which needs no network.
    private func decideLaunchState() {
        SessionCookies.present(in: cookieStore, host: config.baseHost) { [weak self] present, timedOut in
            guard let self = self else { return }
            self.diagnostics.log("session-cookie", ["present": present, "timedOut": timedOut, "attempt": 1])
            if present {
                self.launchSignedIn()
                return
            }
            self.web.loadBlank { [weak self] in
                guard let self = self else { return }
                SessionCookies.present(in: self.cookieStore, host: self.config.baseHost) { [weak self] present, timedOut in
                    guard let self = self else { return }
                    self.diagnostics.log("session-cookie", ["present": present, "timedOut": timedOut, "attempt": 2])
                    if present { self.launchSignedIn() } else { self.model.phase = .signedOut }
                }
            }
        }
    }

    private func launchSignedIn() {
        model.phase = .signedIn
        web.load(path: "/")
    }

    func layoutChanged(tabBarHeight: CGFloat, webFrame: CGRect) {
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
        if !renewing { model.signIn = .entering }
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
        guard model.phase == .signedOut, model.signIn == .entering else { return }
        web.stop()
        model.signIn = .idle
        model.signInMessage = message
    }

    /// The page says nobody is signed in any more.
    private func sessionEnded(reason: String) {
        diagnostics.log("session-ended", ["reason": reason])
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
            if let color = color { self.model.pageBackground = color }
            if let dark = dark { self.model.pageIsDark = dark }
            self.diagnostics.log("chrome", ["css": css, "dark": dark.map { $0 ? 1 : 0 } ?? -1])
        }
    }

    // MARK: - Network and keyboard

    private func networkChanged(offline: Bool) {
        diagnostics.log("network", ["offline": offline, "reason": network.lastReason])
        model.offline = offline
        guard !offline else { return }
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
    }

    // MARK: - WebControllerDelegate

    func webController(_ controller: WebController, didReceive message: [String: Any]) {
        let type = message["type"] as? String ?? ""
        switch type {
        case "ready":
            refreshChrome()
        case "route":
            let path = message["path"] as? String ?? ""
            let signedIn = message["signedIn"] as? Bool ?? false
            if let raw = message["tab"] as? String, let tab = ShellTab(rawValue: raw) {
                model.selectedTab = tab
            }
            if signedIn {
                if model.phase != .signedIn || renewing { finishSignIn() }
            } else if path == "/sign" || path.hasPrefix("/sign/") {
                if model.phase == .signedIn {
                    sessionEnded(reason: "route-sign")
                } else if model.signIn == .entering {
                    failSignIn("Sign-in didn't finish. Try again.")
                }
            }
            refreshChrome()
        case "signed-out":
            if model.phase == .signedIn {
                sessionEnded(reason: "signed-out")
            } else if model.signIn == .entering {
                failSignIn("Sign-in didn't finish. Try again.")
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
        if model.phase == .signedOut, model.signIn == .entering {
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
        if model.phase == .signedIn, onSignPage, !renewing {
            sessionEnded(reason: "url-sign")
        } else if model.phase == .signedOut, model.signIn == .webFallback, !onSignPage, !path.hasPrefix("/api/") {
            SessionCookies.present(in: cookieStore, host: config.baseHost) { [weak self] present, _ in
                guard let self = self, present, self.model.signIn == .webFallback else { return }
                self.diagnostics.log("signed-in-by-url", ["pathRoot": first])
                self.finishSignIn()
            }
        }
    }

    func webControllerDidFinish(_ controller: WebController) {
        // An older web app says nothing over the bridge: read its colours when it has loaded.
        refreshChrome()
    }

    func webControllerDidCommit(_ controller: WebController) {
        model.mainFrameCommits += 1
        if failureSource == .some(.web) || failureSource == nil { clearLoadFailure() }
    }
}
