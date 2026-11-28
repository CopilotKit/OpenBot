import Foundation

/// Where the app points and which test hooks are on, read once at launch.
///
/// The test hooks exist only in DEBUG builds: in a release build every one of them is off whatever
/// the launch environment says, because the code that reads them is not compiled.
struct ShellConfig {
    /// scheme://host[:port] of the OpenBot web app.
    let baseURL: URL
    /// OPENBOT_BASE_URL as given, path and query included: what the DEBUG plain mode loads.
    var startURL: URL?
    /// CFBundleShortVersionString, told to the page as `__OPENBOT_NATIVE_SHELL__.version`.
    let version: String
    let diagnosticsEnabled: Bool
    let testName: String
    /// The sign-in sheet keeps no cookies and shares nothing with Safari, and iOS asks no consent.
    let ephemeralSignIn: Bool

    // DEBUG-only hooks (see README.md).
    var plainWebView = false
    var resetDataStore = false
    var testSessionCookie: String?
    var staleSessionCookie = false
    var handoffAuto = false
    var debugSheetURL: URL?
    var forceOffline = false
    var forceOfflineSeconds: Double?
    /// Draws the whole app, web view included, in dark mode (XCUIDevice's appearance switch does not
    /// reach the app on the CI simulator).
    var forceDark = false
    /// Waits this long before the first page load when signed in, so tests can see the skeleton.
    var delayFirstLoadSeconds: Double?
    /// Plants `better-auth.session_token=<value>` (the plain name the http mock uses).
    var testPlainSessionCookie: String?
    /// Kills the web content process this long after a signed-in launch, as iOS does under memory
    /// pressure, to test the recovery.
    var killContentAfterSeconds: Double?

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> ShellConfig {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        var config = ShellConfig(
            baseURL: resolveBaseURL(environment),
            version: version,
            diagnosticsEnabled: environment["OPENBOT_SHELL_DIAGNOSTICS"] == "1",
            testName: environment["OPENBOT_SHELL_TEST_NAME"] ?? "",
            ephemeralSignIn: environment["OPENBOT_SHELL_EPHEMERAL_SIGN_IN"] == "1"
        )
        if let value = environment["OPENBOT_BASE_URL"], let url = URL(string: value) { config.startURL = url }
        #if DEBUG
        config.plainWebView = environment["OPENBOT_SHELL_PLAIN_WEBVIEW"] == "1"
        config.resetDataStore = environment["OPENBOT_SHELL_RESET"] == "1"
        if let cookie = environment["OPENBOT_SHELL_TEST_SESSION_COOKIE"], !cookie.isEmpty {
            config.testSessionCookie = cookie
        }
        config.staleSessionCookie = environment["OPENBOT_SHELL_TEST_STALE_SESSION"] == "1"
        config.handoffAuto = environment["OPENBOT_SHELL_HANDOFF_AUTO"] == "1"
        if let value = environment["OPENBOT_SHELL_DEBUG_SHEET_URL"], let url = URL(string: value),
           url.scheme == "https" || url.scheme == "http" {
            config.debugSheetURL = url
        }
        config.forceOffline = environment["OPENBOT_SHELL_FORCE_OFFLINE"] == "1"
        if let value = environment["OPENBOT_SHELL_FORCE_OFFLINE_SECONDS"], let seconds = Double(value), seconds > 0 {
            config.forceOfflineSeconds = seconds
        }
        config.forceDark = environment["OPENBOT_SHELL_FORCE_DARK"] == "1"
        if let value = environment["OPENBOT_SHELL_DELAY_FIRST_LOAD_SECONDS"], let seconds = Double(value), seconds > 0 {
            config.delayFirstLoadSeconds = seconds
        }
        if let value = environment["OPENBOT_SHELL_TEST_PLAIN_SESSION_COOKIE"], !value.isEmpty {
            config.testPlainSessionCookie = value
        }
        if let value = environment["OPENBOT_SHELL_TEST_KILL_CONTENT_SECONDS"], let seconds = Double(value), seconds > 0 {
            config.killContentAfterSeconds = seconds
        }
        #endif
        return config
    }

    /// OPENBOT_BASE_URL in the environment wins (tests point the app at a local server with it), then
    /// the OpenBotBaseURL key in Info.plist, then my.open.bot. Reduced to scheme, host and port.
    static func resolveBaseURL(_ environment: [String: String]) -> URL {
        var candidates: [String] = []
        if let value = environment["OPENBOT_BASE_URL"], !value.isEmpty { candidates.append(value) }
        if let value = Bundle.main.object(forInfoDictionaryKey: "OpenBotBaseURL") as? String { candidates.append(value) }
        for candidate in candidates {
            guard let url = URL(string: candidate), let host = url.host, !host.isEmpty,
                  var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { continue }
            components.path = ""
            components.query = nil
            components.fragment = nil
            if let origin = components.url { return origin }
        }
        return URL(string: "https://my.open.bot")!
    }

    var baseHost: String { baseURL.host?.lowercased() ?? "" }

    /// The base URL with a path (which may carry a query) appended.
    func url(_ pathAndQuery: String) -> URL {
        let path = pathAndQuery.hasPrefix("/") ? pathAndQuery : "/" + pathAndQuery
        return URL(string: baseURL.absoluteString + path) ?? baseURL
    }

    /// Whether `url` is on the web app's own origin.
    func isOwnOrigin(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == baseURL.scheme?.lowercased(),
              url.host?.lowercased() == baseHost else { return false }
        return effectivePort(url) == effectivePort(baseURL)
    }

    private func effectivePort(_ url: URL) -> Int {
        if let port = url.port { return port }
        return url.scheme?.lowercased() == "https" ? 443 : 80
    }
}
