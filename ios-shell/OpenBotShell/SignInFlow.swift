import AuthenticationServices
import Foundation
import UIKit

/// The two native parts of signing in: asking the server whether it has the hand-off, and the
/// system sign-in sheet (ASWebAuthenticationSession). The shell (ShellController) decides what to
/// do with the answers. Tickets and verifiers are never logged.
final class SignInFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let callbackScheme = "openbotshell"
    static let timeoutSeconds: TimeInterval = 15

    enum SheetOutcome {
        case ticket(String)
        case cancelled
        case failed(String)
    }

    weak var window: UIWindow?
    private let diagnostics: Diagnostics
    private var session: ASWebAuthenticationSession?
    private let probeSession: URLSession

    init(diagnostics: Diagnostics) {
        self.diagnostics = diagnostics
        // No cookies either way, nothing cached, no redirects followed (NoRedirects), 15 s.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = SignInFlow.timeoutSeconds
        configuration.timeoutIntervalForResource = SignInFlow.timeoutSeconds
        probeSession = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        super.init()
    }

    /// GET `<base>/api/auth/shell/config?platform=ios` (no cookies, no redirects, 15 s) and decide.
    func fetchConfig(base: URL, baseHost: String, completion: @escaping (HandoffMode) -> Void) {
        guard let url = URL(string: base.absoluteString + "/api/auth/shell/config?platform=ios") else {
            completion(.webSignIn(reason: "bad-url"))
            return
        }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var httpsSupported = false
        if #available(iOS 17.4, *) { httpsSupported = true }
        let task = probeSession.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let mode = HandoffConfig.decide(status: error == nil ? status : nil, body: data,
                                            baseHost: baseHost, httpsCallbackSupported: httpsSupported)
            DispatchQueue.main.async {
                var entry: [String: Any] = ["status": status ?? -1, "mode": SignInFlow.describe(mode)]
                if let error = error as NSError? { entry["error"] = "\(error.domain) \(error.code)" }
                self?.diagnostics.log("handoff-config", entry)
                completion(mode)
            }
        }
        task.resume()
    }

    static func describe(_ mode: HandoffMode) -> String {
        switch mode {
        case .unreachable(let reason): return "unreachable " + reason
        case .webSignIn(let reason): return "web " + reason
        case .scheme: return "scheme"
        case .https: return "https"
        }
    }

    /// Whether the server answers at all (any HTTP status), for retrying after a failure.
    func ping(_ url: URL, completion: @escaping (_ answered: Bool) -> Void) {
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        probeSession.dataTask(with: request) { _, response, _ in
            let answered = response is HTTPURLResponse
            DispatchQueue.main.async { completion(answered) }
        }.resume()
    }

    /// Presents the system sign-in sheet on `url` and waits for the callback `mode` names.
    func presentSheet(_ url: URL, mode: HandoffMode, ephemeral: Bool, completion: @escaping (SheetOutcome) -> Void) {
        session?.cancel()
        let handler: (URL?, Error?) -> Void = { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.session = nil
                if let error = error as NSError? {
                    if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                        self?.diagnostics.log("sheet", ["result": "cancelled"])
                        completion(.cancelled)
                    } else {
                        self?.diagnostics.log("sheet", ["result": "error", "domain": error.domain, "code": error.code])
                        completion(.failed("\(error.domain) \(error.code)"))
                    }
                    return
                }
                guard let ticket = HandoffConfig.ticket(from: callbackURL, mode: mode) else {
                    self?.diagnostics.log("sheet", ["result": "no-ticket", "host": callbackURL?.host ?? ""])
                    completion(.failed("no ticket"))
                    return
                }
                self?.diagnostics.log("sheet", ["result": "ticket"])
                completion(.ticket(ticket))
            }
        }
        let session: ASWebAuthenticationSession
        switch mode {
        case .https(let host, let path):
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: path), completionHandler: handler)
            } else {
                completion(.failed("https callback needs iOS 17.4"))
                return
            }
        default:
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: SignInFlow.callbackScheme, completionHandler: handler)
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = ephemeral
        self.session = session
        diagnostics.log("sheet", ["result": "presenting", "url": Diagnostics.redact(url), "ephemeral": ephemeral,
                                  "callback": SignInFlow.describe(mode)])
        if !session.start() {
            self.session = nil
            diagnostics.log("sheet", ["result": "could-not-start"])
            completion(.failed("could not start"))
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = window { return window }
        for scene in UIApplication.shared.connectedScenes {
            if let windowScene = scene as? UIWindowScene, let key = windowScene.keyWindow { return key }
        }
        return ASPresentationAnchor()
    }
}

/// Answers every redirect with "don't follow": the probe wants the server's own status.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
