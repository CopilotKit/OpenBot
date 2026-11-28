import ExpoModulesCore
import UIKit
import WebKit

/// What the shell needs from iOS that React Native and react-native-webview do not give.
///
/// - The web view's cookie store (`WKWebsiteDataStore.default().httpCookieStore`, the one
///   react-native-webview's WKWebView uses): whether a session cookie is there (names only; a value
///   never leaves this file), setting one for a test, and deleting a site's data on sign-out.
/// - Dismissing the keyboard of the web view (React Native's Keyboard.dismiss only knows its own
///   text inputs).
/// - The launch arguments, read by the JavaScript of a test build only.
/// - Whether the hand-off's https callback can be used (iOS 17.4 and later).
///
/// Nothing here copies the session anywhere: no Keychain, no NSHTTPCookieStorage.
public class ShellNativeModule: Module {
  static let sessionCookieNames: Set<String> = ["better-auth.session_token", "__Secure-better-auth.session_token"]

  public func definition() -> ModuleDefinition {
    Name("ShellNative")

    Function("launchArguments") { () -> [String: String] in
      var result: [String: String] = [:]
      // UserDefaults' argument domain holds `-key value` launch arguments (how Maestro passes them).
      for (key, value) in UserDefaults.standard.dictionaryRepresentation() where key.hasPrefix("openbot.") {
        result[key] = "\(value)"
      }
      let arguments = Array(ProcessInfo.processInfo.arguments.dropFirst())
      var index = 0
      while index < arguments.count {
        let key = String(arguments[index].drop(while: { $0 == "-" }))
        if key.hasPrefix("openbot."), index + 1 < arguments.count {
          result[key] = arguments[index + 1]
          index += 2
        } else {
          index += 1
        }
      }
      return result
    }

    Function("httpsCallbackSupported") { (host: String) -> Bool in
      _ = host
      if #available(iOS 17.4, *) { return true }
      return false
    }

    AsyncFunction("hasSessionCookie") { (url: String, promise: Promise) in
      guard let host = URL(string: url)?.host?.lowercased() else {
        promise.resolve(false)
        return
      }
      WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
        let found = cookies.contains { cookie in
          Self.sessionCookieNames.contains(cookie.name) && Self.matches(cookie, host: host) && !cookie.value.isEmpty
            && (cookie.expiresDate.map { $0 > Date() } ?? true)
        }
        promise.resolve(found)
      }
    }.runOnQueue(.main)

    AsyncFunction("setCookie") { (url: String, name: String, value: String, secure: Bool, promise: Promise) in
      guard let host = URL(string: url)?.host else {
        promise.resolve(false)
        return
      }
      var properties: [HTTPCookiePropertyKey: Any] = [
        .domain: host,
        .path: "/",
        .name: name,
        .value: value,
        .expires: Date(timeIntervalSinceNow: 7 * 24 * 3600),
        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
      ]
      if secure { properties[.secure] = "TRUE" }
      guard let cookie = HTTPCookie(properties: properties) else {
        promise.resolve(false)
        return
      }
      WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie) { promise.resolve(true) }
    }.runOnQueue(.main)

    /// Sign-out: every cookie, storage and cache of the site goes (records of its registrable domain).
    AsyncFunction("clearSiteData") { (url: String, promise: Promise) in
      guard let host = URL(string: url)?.host?.lowercased() else {
        promise.resolve(0)
        return
      }
      let store = WKWebsiteDataStore.default()
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      store.httpCookieStore.getAllCookies { cookies in
        let mine = cookies.filter { Self.matches($0, host: host) }
        let group = DispatchGroup()
        for cookie in mine {
          group.enter()
          store.httpCookieStore.delete(cookie) { group.leave() }
        }
        group.notify(queue: .main) {
          store.fetchDataRecords(ofTypes: types) { records in
            let site = records.filter { record in
              let name = record.displayName.lowercased()
              return host == name || host.hasSuffix("." + name)
            }
            store.removeData(ofTypes: types, for: site) {
              promise.resolve(mine.count)
            }
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("clearAllData") { (promise: Promise) in
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
        modifiedSince: Date.distantPast
      ) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)

    /// Android's trampoline needs it; iOS registers no callback scheme at all.
    Function("setSignInPending") { (pending: Bool) -> Bool in
      _ = pending
      return true
    }

    /// WKHTTPCookieStore has no supported flush: WebKit writes cookies to disk lazily (a known limit).
    Function("flushCookies") { () -> Bool in
      return false
    }

    Function("dismissKeyboard") { () -> Void in
      DispatchQueue.main.async {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      }
    }
  }

  static func matches(_ cookie: HTTPCookie, host: String) -> Bool {
    let domain = cookie.domain.lowercased()
    let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
    return host == bare || host.hasSuffix("." + bare)
  }
}
