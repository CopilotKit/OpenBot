import Foundation
import WebKit

/// The web app's session cookie in the web view's cookie store: whether it is there, removing it,
/// and (DEBUG) planting one. Never reads or logs a value.
enum SessionCookies {
    static let plainName = "better-auth.session_token"
    static let secureName = "__Secure-better-auth.session_token"
    static let names: Set<String> = [plainName, secureName]

    static func isSessionCookie(_ cookie: HTTPCookie, host: String) -> Bool {
        guard names.contains(cookie.name) else { return false }
        var domain = cookie.domain.lowercased()
        if domain.hasPrefix(".") { domain.removeFirst() }
        return host == domain || host.hasSuffix("." + domain)
    }

    /// Whether a session cookie for `host` is in the store. Answers on the main queue, within
    /// `timeout` seconds even if WebKit never calls back (then: false).
    static func present(in store: WKHTTPCookieStore, host: String, timeout: TimeInterval = 5,
                        completion: @escaping (_ present: Bool, _ timedOut: Bool) -> Void) {
        var answered = false
        let answer: (Bool, Bool) -> Void = { present, timedOut in
            DispatchQueue.main.async {
                guard !answered else { return }
                answered = true
                completion(present, timedOut)
            }
        }
        store.getAllCookies { cookies in
            answer(cookies.contains { isSessionCookie($0, host: host) }, false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { answer(false, true) }
    }

    /// Deletes both session cookies for `host` and leaves every other cookie alone.
    static func delete(in store: WKHTTPCookieStore, host: String, completion: @escaping (_ deleted: Int) -> Void) {
        store.getAllCookies { cookies in
            let doomed = cookies.filter { isSessionCookie($0, host: host) }
            let group = DispatchGroup()
            for cookie in doomed {
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) { completion(doomed.count) }
        }
    }

    /// Plants a session cookie (DEBUG test hooks only call this).
    static func set(name: String, value: String, secure: Bool, host: String,
                    in store: WKHTTPCookieStore, completion: @escaping (_ ok: Bool) -> Void) {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: host,
            .path: "/",
            .expires: Date().addingTimeInterval(30 * 24 * 3600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]
        if secure { properties[.secure] = "TRUE" }
        guard let cookie = HTTPCookie(properties: properties) else {
            DispatchQueue.main.async { completion(false) }
            return
        }
        store.setCookie(cookie) { DispatchQueue.main.async { completion(true) } }
    }
}
