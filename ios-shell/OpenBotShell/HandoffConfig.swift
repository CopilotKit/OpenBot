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
