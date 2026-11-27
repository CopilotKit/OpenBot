import Foundation
import SafariServices
import SwiftUI
import UIKit
import WebKit

/// Owns the one WKWebView and acts as its navigation and UI delegate.
final class WebController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    @Published var errorMessage: String?

    let baseURL: URL
    let webView: WKWebView
    private let diagnostics: Diagnostics
    private var started = false
    private var lastRequestedURL: URL?

    /// OPENBOT_BASE_URL in the environment wins (tests point the app at the probe with it), then
    /// the OpenBotBaseURL key in Info.plist, then my.open.bot.
    static func resolveBaseURL() -> URL {
        if let value = ProcessInfo.processInfo.environment["OPENBOT_BASE_URL"], !value.isEmpty,
           let url = URL(string: value) {
            return url
        }
        if let value = Bundle.main.object(forInfoDictionaryKey: "OpenBotBaseURL") as? String,
           let url = URL(string: value) {
            return url
        }
        return URL(string: "https://my.open.bot")!
    }

    override init() {
        let baseURL = WebController.resolveBaseURL()
        let environment = ProcessInfo.processInfo.environment
        let diagnostics = Diagnostics(enabled: environment["OPENBOT_SHELL_DIAGNOSTICS"] == "1")

        let configuration = WKWebViewConfiguration()
        // Persistent store, so cookies and localStorage survive a relaunch like they do in Safari.
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        // Audio and video play in the page instead of jumping to the full-screen player.
        configuration.allowsInlineMediaPlayback = true
        // Appended to the Safari-like UA so the web app can recognize the shell later.
        configuration.applicationNameForUserAgent = "OpenBotShell-iOS/0.1"
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
        // The page lays itself out under the bars; it reads env(safe-area-inset-*) to avoid them.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // No white flash before the first paint in dark mode.
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        // UI tests find the web view by this identifier.
        webView.accessibilityIdentifier = "openbot-webview"
        #if DEBUG
        // Lets Safari's Web Inspector attach to debug builds.
        webView.isInspectable = true
        #endif

        self.baseURL = baseURL
        self.diagnostics = diagnostics
        self.webView = webView
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self

        diagnostics.log("launch", [
            "baseURL": Diagnostics.redact(baseURL),
            "test": environment["OPENBOT_SHELL_TEST_NAME"] ?? "",
            "systemVersion": UIDevice.current.systemVersion,
            "model": UIDevice.current.model,
        ])
    }

    func start() {
        guard !started else { return }
        started = true
        load(baseURL)
    }

    func retry() {
        diagnostics.log("retry", ["url": lastRequestedURL.map(Diagnostics.redact) ?? ""])
        errorMessage = nil
        if webView.url == nil {
            load(lastRequestedURL ?? baseURL)
        } else {
            webView.reload()
        }
    }

    private func load(_ url: URL) {
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    private var baseHost: String? { baseURL.host?.lowercased() }

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
        // Web content schemes stay in the web view. Step 1 also keeps OAuth redirects in here on
        // purpose, to see what breaks.
        if ["http", "https", "about", "data", "blob", "javascript"].contains(scheme) {
            decisionHandler(.allow)
            return
        }
        // mailto:, tel: and app links go to the system.
        diagnostics.log("open-external", ["scheme": scheme])
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
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
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if let url = webView.url { lastRequestedURL = url }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        errorMessage = nil
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
        if webView.url == nil {
            load(lastRequestedURL ?? baseURL)
        } else {
            webView.reload()
        }
    }

    private func handle(_ error: Error, phase: String) {
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
        errorMessage = nsError.localizedDescription
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let sameHost = url.host?.lowercased() == baseHost
        diagnostics.log("create-web-view", ["url": Diagnostics.redact(url), "sameHost": sameHost])
        let scheme = url.scheme?.lowercased() ?? ""
        if sameHost {
            // Same-host popups replace the current page: the shell has one web view.
            webView.load(navigationAction.request)
        } else if scheme == "http" || scheme == "https" {
            // Other sites open in an in-app Safari sheet.
            if let presenter = topViewController() {
                presenter.present(SFSafariViewController(url: url), animated: true)
            }
        } else {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        diagnostics.log("js-alert", [:])
        guard let presenter = topViewController() else {
            completionHandler()
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        diagnostics.log("js-confirm", [:])
        guard let presenter = topViewController() else {
            completionHandler(false)
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        diagnostics.log("js-prompt", [:])
        guard let presenter = topViewController() else {
            completionHandler(nil)
            return
        }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
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
        let granted = origin.host.lowercased() == baseHost
        diagnostics.log("media-permission", [
            "origin": "\(origin.protocol)://\(origin.host):\(origin.port)",
            "type": type.rawValue,
            "granted": granted,
        ])
        decisionHandler(granted ? .grant : .deny)
    }

    // MARK: - Helpers

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
        ]
        webView.evaluateJavaScript(Diagnostics.snapshotScript) { [weak self] result, error in
            guard let self = self else { return }
            var entry: [String: Any] = ["reason": reason, "nativeSafeAreaInsets": native]
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
