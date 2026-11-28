import Combine
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
    /// A page of the web app has said `ready` on the bridge: from then on only its own `signed-out`
    /// and `route` messages end the session, never the URL alone.
    private var bridgeSeen = false
    /// Ends the skeleton at the latest this long after a page commits (a hung subresource).
    static let skeletonDeadlineAfterCommit: TimeInterval = 15
    private var commitDeadline: DispatchWorkItem?
    private var phaseWatch: AnyCancellable?

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
        phaseWatch = model.$phase.sink { [weak web = self.web] phase in web?.signedIn = phase == .signedIn }
        if config.plainWebView { model.phase = .plain }
        model.serverHost = ServerAddress.display(config.baseURL)
        model.selfHosted = config.isSelfHosted
        diagnostics.log("launch", [
            "baseURL": Diagnostics.redact(config.baseURL),
            "version": config.version,
            "systemVersion": UIDevice.current.systemVersion,
            "model": UIDevice.current.model,
            "plain": config.plainWebView,
            "ephemeralSignIn": config.ephemeralSignIn,
        ])
    }

    /// Set by the scene: builds the app again for the newly chosen server.
    var onRestart: (() -> Void)?

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
                guard let self = self else { return }
                let store = self.web.webView.configuration.websiteDataStore
                let current = self.config.dataStoreID
                store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                    // Other servers' stores from earlier tests go too.
                    WKWebsiteDataStore.fetchAllDataStoreIdentifiers { ids in
                        for id in ids where id != current { WKWebsiteDataStore.remove(forIdentifier: id) { _ in } }
                        self.diagnostics.log("test-hook", ["hook": "reset-data-store", "otherStores": ids.count])
                        DispatchQueue.main.async { next() }
                    }
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
                    #if DEBUG
                    if !present, let value = self.config.testLateSessionCookie {
                        SessionCookies.set(name: SessionCookies.plainName, value: value, secure: false,
                                           host: self.config.baseHost, in: self.cookieStore) { ok in
                            self.diagnostics.log("test-hook", ["hook": "late-session-cookie", "ok": ok])
                        }
                    }
                    #endif
                }
            }
        }
    }

    private func launchSignedIn() {
        beginPageLoad("launch")
        model.phase = .signedIn
        #if DEBUG
        if let kill = config.killContentAfterSeconds {
            DispatchQueue.main.asyncAfter(deadline: .now() + kill) { [weak self] in
                guard let webView = self?.web.webView else { return }
                // WebKit's own test hook (private, DEBUG builds only).
                let selector = NSSelectorFromString("_killWebContentProcess")
                self?.diagnostics.log("test-hook", ["hook": "kill-content", "available": webView.responds(to: selector)])
                if webView.responds(to: selector) { webView.perform(selector) }
            }
        }
        if let probe = config.testEnterProbeURL, let after = config.testEnterProbeAfterSeconds {
            // A renewal's `enter` call while a page is showing, pointed at the probe.
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                guard let self = self else { return }
                self.diagnostics.log("test-hook", ["hook": "enter-probe-while-signed-in"])
                self.renewing = true
                self.web.load(probe, headers: [ShellController.shellHeader: "ios"], remember: self.config.url("/"))
            }
        }
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
        if !model.pageLoading { model.skeletonsShown += 1 }
        pageSaidReady = false
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
    /// The page said `ready` since the skeleton went up. A web app can say it before it has drawn
    /// anything (it did, waiting on slow first requests): the skeleton then waits for one piece of
    /// visible text instead of three.
    private var pageSaidReady = false

    private func checkPageDrawn(attempt: Int = 0) {
        guard model.pageLoading else { return }
        if attempt == 0 { loadingCheck?.cancel() }
        let needed = pageSaidReady ? 1 : 3
        // Drawn: the document is complete and at least three pieces of text are really on screen:
        // inside the viewport, not hidden, not faded out, more than 4 px (screen-reader-only text
        // measures 1 px).
        let script = """
        (function () {
          if (document.readyState !== 'complete' || !document.body) return false;
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          var seen = 0, node, range = document.createRange();
          while ((node = walker.nextNode()) && seen < \(needed)) {
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
          return seen >= \(needed);
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

    // MARK: - A self-hosted OpenBot

    /// The quiet control (or Change address on the lock screen): the address field opens.
    func openAddress(overLock: Bool) {
        // The current address, with its scheme when it is not https (a debug build's local server).
        let current = (config.baseURL.scheme == "https" ? "" : "\(config.baseURL.scheme ?? "http")://") + ServerAddress.display(config.baseURL)
        model.addressText = overLock && config.isSelfHosted ? current : ""
        model.addressError = nil
        model.addressOverLock = overLock
        model.addressOpen = true
    }

    func cancelAddress() {
        guard !model.addressChecking else { return }
        model.addressOpen = false
        model.addressOverLock = false
        model.addressError = nil
    }

    /// Continue: check the address is an OpenBot the app can use, then switch to it.
    func chooseServer(_ typed: String) {
        guard !model.addressChecking else { return }
        var allowHTTP = false
        #if DEBUG
        allowHTTP = true
        #endif
        switch ServerAddress.parse(typed, allowDevelopmentHTTP: allowHTTP) {
        case .failure(let problem):
            model.addressError = ServerAddress.message(problem)
        case .success(let origin):
            if origin == config.cloudURL {
                // OpenBot Cloud's own address: simply back to Cloud.
                switchServer(to: nil)
                return
            }
            if origin == config.baseURL {
                cancelAddress()
                return
            }
            model.addressChecking = true
            diagnostics.log("server-choose", ["host": ServerAddress.display(origin)])
            signInFlow.checkServer(origin) { [weak self] result in
                guard let self = self else { return }
                self.model.addressChecking = false
                if result == .accepted {
                    self.switchServer(to: origin)
                } else {
                    self.model.addressError = SignInFlow.message(result, host: ServerAddress.display(origin))
                }
            }
        }
    }

    /// Use OpenBot Cloud.
    func useCloud() {
        switchServer(to: nil)
    }

    /// Changing server: the sign-in in progress is dropped and the site's data cleared (awaited),
    /// then the choice is kept and the app is built again, so every "own origin" use follows it.
    private func switchServer(to origin: URL?) {
        diagnostics.log("server-switch", ["to": origin.map(ServerAddress.display) ?? "cloud"])
        signInFlow.cancel()
        enterTimeout?.cancel()
        renewing = false
        web.stop()
        model.signIn = .idle
        model.addressChecking = true
        // Each server has a data store of its own: the new one is simply another store, nothing to
        // wait for. The old one is removed once its web view is gone.
        let oldStore = config.dataStoreID
        ShellConfig.saveSelfHosted(origin)
        model.addressChecking = false
        onRestart?()
        ShellController.removeStore(oldStore, attempt: 1)
    }

    /// Removes a server's data store in the background (it fails while a web view still uses it:
    /// tried again a few times).
    static func removeStore(_ id: UUID, attempt: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(attempt)) {
            WKWebsiteDataStore.remove(forIdentifier: id) { error in
                if error != nil, attempt < 5 { removeStore(id, attempt: attempt + 1) }
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

    /// The hand-off's path: `/api/auth/shell/handoff?challenge=<C>&platform=ios&callback=<what the config said>`.
    private func handoffPath(challenge: String, mode: HandoffMode) -> String {
        var path = ShellURLs.handoffPath(challenge: challenge, callback: ShellURLs.callbackName(mode))
        #if DEBUG
        if config.handoffAuto { path += "&auto=1" }
        #endif
        return path
    }

    private func enterURL(ticket: String, verifier: String, to path: String) -> URL {
        ShellURLs.enterURL(base: config.baseURL, ticket: ticket, verifier: verifier, to: path)
            ?? config.url("/sign?native-sign-in=failed")
    }

    /// The sheet: the hand-off itself to sign in; for a renewal, the hosted sign-in returning to the
    /// hand-off (backend docs/shell-sign-in.md, "Renewing the hosted sign-in"). `returnTo` is where
    /// `enter` sends the web view afterwards.
    private func presentSheet(pair: PKCEPair, mode: HandoffMode, returnTo: String) {
        if !renewing { model.signIn = .sheet }
        let path = handoffPath(challenge: pair.challenge, mode: mode)
        let sheetURL = renewing ? (ShellURLs.renewalSheetURL(base: config.baseURL, handoffPath: path) ?? config.url(path))
                                : config.url(path)
        signInFlow.presentSheet(sheetURL, mode: mode, ephemeral: config.ephemeralSignIn) { [weak self] outcome in
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
            // The session may well be there (a web app slow to boot, or one without the bridge).
            SessionCookies.present(in: self.cookieStore, host: self.config.baseHost) { [weak self] present, _ in
                guard let self = self else { return }
                self.diagnostics.log("enter-timeout", ["seconds": SignInFlow.timeoutSeconds, "cookie": present])
                if present, self.model.signIn == .entering, !self.onSignPage {
                    self.finishSignIn()
                } else {
                    self.failSignIn("Sign-in took too long. Try again.")
                }
            }
        }
        enterTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + SignInFlow.timeoutSeconds, execute: timeout)
        // The header tells the server this request comes from the app (no session without it: a
        // page elsewhere cannot make the web view sign in to someone else's account). A retry or a
        // restarted web process loads `path`, never the one-time enter URL again.
        var url = enterURL(ticket: ticket, verifier: verifier, to: path)
        #if DEBUG
        if let probe = config.testEnterProbeURL { url = probe }
        #endif
        let load = { [weak self] in
            guard let self = self else { return }
            self.web.load(url, headers: [ShellController.shellHeader: "ios"], remember: self.config.url(path))
        }
        if renewing {
            // The same person's session stays until the new one replaces it.
            load()
        } else {
            // Signed out, the web view can still hold a live session (WebKit can answer "no cookies"
            // at a cold launch, see decideLaunchState). The server refuses `enter` for a web view
            // holding another person's session, so the site's data goes first, and `enter` loads
            // only once that has finished.
            clearSiteData(reason: "before-enter") { [weak self] finished in
                guard let self = self, self.model.signIn == .entering else { return }
                if finished {
                    load()
                } else {
                    // Never sign in on unknown state: the leftover session may still be there.
                    self.failSignIn("Sign-in didn't finish. Try again.")
                }
            }
        }
    }

    static let shellHeader = "OpenBot-Shell"

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
        clearSiteData(reason: "sign-out")
    }

    /// Everything the web app's site stored (cookies, local storage, IndexedDB, caches) goes at sign
    /// out, so the next person to sign in on this phone finds nothing of the last one.
    /// Clears every piece of data the site stored but Cloudflare's clearance cookie (`cf_clearance`,
    /// which only says this device passed Cloudflare's check, as the Android app keeps it): cookies,
    /// local storage, IndexedDB, caches. Calls back on the main queue when it has finished. A clear
    /// that is still running is waited for, so a sign-in that starts during sign-out's clear loads
    /// `enter` only after it.
    private var siteDataClearWaiters: [() -> Void]?
    /// Calls back with true once the clear has finished, or false after 4 s without an answer from
    /// WebKit (it did not answer once, right after a change of server in run 46164083101, when all
    /// servers shared 1 store; each now has its own). The caller then fails rather than going on.
    private func clearSiteData(reason: String, completion: ((Bool) -> Void)? = nil) {
        var completion = completion
        if let inner = completion {
            var called = false
            let once = { [weak self] (finished: Bool) in
                guard !called else { return }
                called = true
                if !finished { self?.diagnostics.log("site-data-clear-timeout", ["reason": reason]) }
                inner(finished)
            }
            completion = { _ in once(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { once(false) }
        }
        if siteDataClearWaiters != nil {
            // One clear at a time; a later caller waits for this one and then clears again.
            siteDataClearWaiters?.append { [weak self] in self?.clearSiteData(reason: reason, completion: completion) }
            return
        }
        siteDataClearWaiters = []
        let store = web.webView.configuration.websiteDataStore
        var types = WKWebsiteDataStore.allWebsiteDataTypes()
        types.remove(WKWebsiteDataTypeCookies)
        let host = config.baseHost
        let mineHost = { (domain: String) -> Bool in
            let d = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            return host == d || host.hasSuffix("." + d)
        }
        store.fetchDataRecords(ofTypes: types) { [weak self] records in
            let mine = records.filter { mineHost($0.displayName) }
            store.removeData(ofTypes: types, for: mine) {
                store.httpCookieStore.getAllCookies { cookies in
                    let doomed = cookies.filter { mineHost($0.domain) && $0.name != "cf_clearance" }
                    let group = DispatchGroup()
                    for cookie in doomed {
                        group.enter()
                        store.httpCookieStore.delete(cookie) { group.leave() }
                    }
                    group.notify(queue: .main) {
                        guard let self = self else { return }
                        self.diagnostics.log("site-data-cleared", ["records": mine.count, "cookies": doomed.count, "reason": reason])
                        self.model.siteDataClears += 1
                        let waiters = self.siteDataClearWaiters ?? []
                        self.siteDataClearWaiters = nil
                        completion?(true)
                        waiters.forEach { $0() }
                    }
                }
            }
        }
    }

    private var onSignPage: Bool {
        guard let url = web.webView.url, config.isOwnOrigin(url) else { return false }
        return url.path == "/sign" || url.path.hasPrefix("/sign/")
    }

    // MARK: - Tabs

    func selectTab(_ tab: ShellTab) {
        // While the enter page loads, a tab would replace it and lose the sign-in.
        guard model.signIn != .entering else {
            diagnostics.log("tab-ignored", ["tab": tab.rawValue, "why": "entering"])
            return
        }
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
            self?.web.keyboardIsUp = true
        })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.model.keyboardVisible = false
            self?.web.keyboardIsUp = false
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
            bridgeSeen = true
            // The skeleton goes once the page really shows something (`checkPageDrawn`).
            pageSaidReady = true
            checkPageDrawn()
            refreshChrome()
        case "route":
            let path = message["path"] as? String ?? ""
            let signedIn = message["signedIn"] as? Bool ?? false
            if let raw = message["tab"] as? String, let tab = ShellTab(rawValue: raw) {
                model.selectedTab = tab
            }
            // `canGoBack` (the web app's per-tab stacks) decides the edge swipe; absent, the web
            // view's own back as before.
            web.updateBack(canGoBack: message["canGoBack"] as? Bool, depth: message["depth"] as? Int,
                           tab: message["tab"] as? String)
            switch web.backMode {
            case .webHistory: model.backMode = "web"
            case .sendToPage: model.backMode = "page"
            case .nothing: model.backMode = "none"
            }
            if signedIn {
                if model.phase != .signedIn || renewing || model.signIn == .entering { finishSignIn() }
            } else if path == "/sign" || path.hasPrefix("/sign/") {
                if model.signIn == .entering {
                    failSignIn("Sign-in didn't finish. Try again.")
                } else if renewing {
                    // The outgoing page during a renewal: the server replaces its session, and a
                    // request in flight can see the old one gone. The renewal's own result decides.
                    diagnostics.log("route-sign-ignored", ["why": "renewal"])
                } else if model.phase == .signedIn {
                    sessionEnded(reason: "route-sign")
                }
            }
            refreshChrome()
        case "signed-out":
            if model.signIn == .entering {
                failSignIn("Sign-in didn't finish. Try again.")
            } else if renewing {
                diagnostics.log("signed-out-ignored", ["why": "renewal"])
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
        // Back to where the web app asked to return (its `returnTo` on this host), else "/".
        let returnTo = ShellURLs.renewalTarget(from: url, baseHost: config.baseHost)
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
        } else if model.signIn == .entering, !path.hasPrefix("/api/") {
            // On the web app and not on the sign-in page: signed in if the cookie is there, without
            // waiting for a `route` (a web app without shell mode never sends one).
            SessionCookies.present(in: cookieStore, host: config.baseHost) { [weak self] present, _ in
                guard let self = self, present, self.model.signIn == .entering, !self.onSignPage else { return }
                self.diagnostics.log("signed-in-by-url", ["pathRoot": first, "while": "entering"])
                self.finishSignIn()
            }
        } else if model.phase == .signedIn, onSignPage, !renewing {
            if bridgeSeen {
                // The page's own `signed-out` or `route` says whether the session ended; its /sign
                // route sends a signed-in person on to "/".
                diagnostics.log("sign-page-ignored", ["why": "bridge"])
            } else {
                // No bridge: ended only if the session cookie is really gone after a moment.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                    guard let self = self, self.model.phase == .signedIn else { return }
                    SessionCookies.present(in: self.cookieStore, host: self.config.baseHost) { [weak self] present, _ in
                        guard let self = self, self.model.phase == .signedIn else { return }
                        self.diagnostics.log("sign-page-cookie", ["present": present])
                        if !present { self.sessionEnded(reason: "url-sign") }
                    }
                }
            }
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
        model.contentRestarts += 1
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
        if model.pageLoading {
            commitDeadline?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.endPageLoad("deadline-after-commit") }
            commitDeadline = item
            DispatchQueue.main.asyncAfter(deadline: .now() + ShellController.skeletonDeadlineAfterCommit, execute: item)
        }
        if failureSource == .some(.web) || failureSource == nil { clearLoadFailure() }
    }

    func webController(_ controller: WebController, otherSiteFailed url: URL) {
        // The web view goes back to the web app's last page by itself; nothing locks.
        diagnostics.log("other-site-failed-handled", ["webFallback": model.signIn == .webFallback])
    }
}
