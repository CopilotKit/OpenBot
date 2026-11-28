import Foundation

/// What the server's `GET /api/auth/shell/config?platform=ios` answer means for signing in.
/// Pure logic (no networking), so the UI test target compiles this file too and tests it.
enum HandoffMode: Equatable {
    /// No answer at all (network error, timeout): the lock screen.
    case unreachable(reason: String)
    /// The server has no hand-off, or answered something this app does not understand: the web
    /// app's own sign-in in the web view.
    case webSignIn(reason: String)
    /// The sheet finishes on `openbotshell://signed-in?ticket=`.
    case scheme
    /// The sheet finishes on `https://<host><path>?ticket=`, which only this app (associated with the
    /// domain) can claim. iOS 17.4 and later.
    case https(host: String, path: String)
}

enum HandoffConfig {
    static let schemeCallback = "openbotshell://signed-in"

    /// Decides from the HTTP status (nil: no answer) and body. Strict: `handoff` must be a boolean;
    /// when true, `callback` must be "scheme" with `callbackUrl` exactly openbotshell://signed-in, or
    /// "https" with an https `callbackUrl` on the base URL's own host and a path. Anything else is the
    /// web sign-in. Keys beyond these are ignored, so the server can add some.
    static func decide(status: Int?, body: Data?, baseHost: String, httpsCallbackSupported: Bool) -> HandoffMode {
        guard let status = status else { return .unreachable(reason: "no-answer") }
        guard status == 200 else { return .webSignIn(reason: "status-\(status)") }
        guard let body = body,
              let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            return .webSignIn(reason: "not-json-object")
        }
        guard let flag = object["handoff"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else {
            return .webSignIn(reason: "handoff-not-boolean")
        }
        guard flag.boolValue else { return .webSignIn(reason: "handoff-off") }
        guard let callback = object["callback"] as? String, let callbackText = object["callbackUrl"] as? String else {
            return .webSignIn(reason: "callback-missing")
        }
        switch callback {
        case "scheme":
            return callbackText == schemeCallback ? .scheme : .webSignIn(reason: "scheme-url-unexpected")
        case "https":
            guard let url = URL(string: callbackText), url.scheme?.lowercased() == "https",
                  let host = url.host?.lowercased(), host == baseHost.lowercased(),
                  url.port == nil, url.query == nil, url.fragment == nil,
                  !url.path.isEmpty, url.path != "/" else {
                return .webSignIn(reason: "https-url-unexpected")
            }
            guard httpsCallbackSupported else { return .webSignIn(reason: "https-callback-needs-ios-17.4") }
            return .https(host: host, path: url.path)
        default:
            return .webSignIn(reason: "callback-unknown")
        }
    }

    /// Whether a URL the sheet finished on is the callback this mode expects, and its ticket.
    static func ticket(from callbackURL: URL?, mode: HandoffMode) -> String? {
        guard let url = callbackURL else { return nil }
        switch mode {
        case .scheme:
            guard url.scheme?.lowercased() == "openbotshell", url.host == "signed-in" else { return nil }
        case .https(let host, let path):
            guard url.scheme?.lowercased() == "https", url.host?.lowercased() == host, url.path == path else { return nil }
        default:
            return nil
        }
        let ticket = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "ticket" })?.value
        return (ticket?.isEmpty ?? true) ? nil : ticket
    }
}

/// The sign-in hand-off's URLs, built exactly as the server's contract says
/// (docs/shell-sign-in.md in the backend: "The enter contract", "Renewing the hosted sign-in").
/// Pure, so the UI test target tests it against the contract's worked example.
enum ShellURLs {
    /// Percent-encodes every character outside `A-Z a-z 0-9 - _ . ~` (UTF-8, capital hex), so a path
    /// with its query goes as one query value: `/`, `?`, `=` and `&` become `%2F`, `%3F`, `%3D`, `%26`.
    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")

    /// The callback value the hand-off is told, from what the config said.
    static func callbackName(_ mode: HandoffMode) -> String? {
        switch mode {
        case .scheme: return "scheme"
        case .https: return "https"
        default: return nil
        }
    }

    /// `/api/auth/shell/handoff?challenge=<C>&platform=ios&callback=<https|scheme>`, in that order.
    static func handoffPath(challenge: String, platform: String = "ios", callback: String?) -> String {
        var path = "/api/auth/shell/handoff?challenge=\(encode(challenge))&platform=\(encode(platform))"
        if let callback = callback { path += "&callback=\(encode(callback))" }
        return path
    }

    /// The renewal's sheet: the hosted sign-in, returning to the hand-off.
    static func renewalSheetURL(base: URL, handoffPath: String) -> URL? {
        URL(string: base.absoluteString + "/api/auth/hosted/sign-in?returnTo=" + encode(handoffPath))
    }

    /// `enter`, every value encoded as one query value.
    static func enterURL(base: URL, ticket: String, verifier: String, to: String) -> URL? {
        URL(string: base.absoluteString + "/api/auth/shell/enter?ticket=\(encode(ticket))&verifier=\(encode(verifier))&to=\(encode(to))")
    }

    /// Where a renewal comes back to: the intercepted hosted sign-in's `returnTo`, decoded once,
    /// when it is an absolute URL on the OpenBot host (its path, query and fragment); `/` otherwise.
    static func renewalTarget(from intercepted: URL, baseHost: String) -> String {
        guard let items = URLComponents(url: intercepted, resolvingAgainstBaseURL: false)?.queryItems,
              let raw = items.first(where: { $0.name == "returnTo" })?.value,
              let target = URLComponents(string: raw),
              let scheme = target.scheme?.lowercased(), scheme == "https" || scheme == "http",
              target.host?.lowercased() == baseHost.lowercased() else { return "/" }
        var to = target.percentEncodedPath.isEmpty ? "/" : target.percentEncodedPath
        guard to.hasPrefix("/"), !to.hasPrefix("//") else { return "/" }
        if let query = target.percentEncodedQuery { to += "?" + query }
        if let fragment = target.percentEncodedFragment { to += "#" + fragment }
        return to
    }
}

/// What a swipe back from the left edge does, from the page's last `route` message. Pure, so the UI
/// test target tests it. The web app's per-tab stacks say `canGoBack`; a page that never says it
/// (production today, a page without the bridge) keeps the web view's own back gesture.
enum ShellBack: Equatable {
    /// WebKit's own back-forward gesture over the web view's history (with the shell's guards).
    case webHistory
    /// The shell's own edge swipe sends `openbot:back` to the page.
    case sendToPage
    /// The shell's own edge swipe does nothing (the current tab is at its root).
    case nothing

    static func decide(canGoBack: Bool?) -> ShellBack {
        guard let canGoBack = canGoBack else { return .webHistory }
        return canGoBack ? .sendToPage : .nothing
    }

    /// Whether WebKit's own back-forward gesture is on (never while the page keeps its own stacks:
    /// a mixed history must not be walked).
    var usesWebKitGesture: Bool { self == .webHistory }
}

/// A self-hosted OpenBot's address as a person types it, checked before anything is fetched.
/// Pure, so the UI test target tests it.
enum ServerAddress {
    enum Problem: Equatable {
        case empty
        case notAnAddress
        case credentials
        case insecure
    }

    /// The origin (scheme, host, port; no path) for what was typed, or why it cannot be one. A host
    /// alone means https. `http` only for a development host, and only where `allowDevelopmentHTTP`
    /// (DEBUG builds).
    static func parse(_ typed: String, allowDevelopmentHTTP: Bool) -> Result<URL, Problem> {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .failure(.empty) }
        let lower = text.lowercased()
        let withScheme: String
        if lower.hasPrefix("https://") || lower.hasPrefix("http://") {
            withScheme = text
        } else if lower.contains("://") {
            return .failure(.notAnAddress)
        } else {
            withScheme = "https://" + text
        }
        guard let components = URLComponents(string: withScheme), let rawHost = components.host, !rawHost.isEmpty else {
            return .failure(.notAnAddress)
        }
        if components.user != nil || components.password != nil { return .failure(.credentials) }
        let host = rawHost.lowercased()
        let hostOK = host.range(of: "^[a-z0-9.\\-\\[\\]:]+$", options: .regularExpression) != nil
            && !host.hasPrefix(".") && !host.hasSuffix(".") && !host.contains("..")
        guard hostOK, host.contains(".") || isDevelopmentHost(host) else { return .failure(.notAnAddress) }
        let scheme = (components.scheme ?? "https").lowercased()
        if scheme == "http" && !(allowDevelopmentHTTP && isDevelopmentHost(host)) { return .failure(.insecure) }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        let defaultPort = scheme == "https" ? 443 : 80
        if let port = components.port, port != defaultPort { origin.port = port }
        guard let url = origin.url else { return .failure(.notAnAddress) }
        return .success(url)
    }

    static func isDevelopmentHost(_ host: String) -> Bool {
        ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host) || host.hasSuffix(".localhost") || host.hasSuffix(".test")
    }

    /// The host as it is shown back to a person: lower case, the port only when it is not the default.
    static func display(_ origin: URL) -> String {
        guard let host = origin.host else { return origin.absoluteString }
        if let port = origin.port { return "\(host):\(port)" }
        return host
    }

    /// The sentence for a problem with what was typed (the openbot-copy wording, as on Android).
    static func message(_ problem: Problem) -> String {
        switch problem {
        case .empty: return "Enter your OpenBot's address, like openbot.example.com."
        case .notAnAddress: return "That doesn't look like an address. Enter one like openbot.example.com."
        case .credentials: return "Leave the user name and password out of the address."
        case .insecure: return "The app connects only over https. Use an address that starts with https:// or has no prefix."
        }
    }
}
