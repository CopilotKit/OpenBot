import AuthenticationServices
import Foundation
import UIKit

/// The two native parts of signing in: asking the server whether it has the hand-off, and the
/// system sign-in sheet (ASWebAuthenticationSession). The shell (ShellController) decides what to
/// do with the answers. Tickets and verifiers are never logged.
final class SignInFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let callbackScheme = "openbotshell"
    static let timeoutSeconds: TimeInterval = 15

    enum Probe {
        case supported(status: Int)
        case unsupported(status: Int?, reason: String)
    }

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

    /// GET the hand-off URL. 404 or a network error: no hand-off. Anything else: it is there.
    func probe(_ url: URL, completion: @escaping (Probe) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        let task = probeSession.dataTask(with: request) { [weak self] _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let result: Probe
            if let error = error as NSError? {
                result = .unsupported(status: nil, reason: "\(error.domain) \(error.code)")
            } else if status == 404 {
                result = .unsupported(status: 404, reason: "404")
            } else {
                result = .supported(status: status ?? 0)
            }
            DispatchQueue.main.async {
                switch result {
                case .supported(let status):
                    self?.diagnostics.log("handoff-probe", ["status": status, "supported": true])
                case .unsupported(let status, let reason):
                    self?.diagnostics.log("handoff-probe", ["status": status ?? -1, "supported": false, "reason": reason])
                }
                completion(result)
            }
        }
        task.resume()
    }

    /// Presents the system sign-in sheet on `url` and waits for `openbotshell://signed-in?ticket=`.
    func presentSheet(_ url: URL, ephemeral: Bool, completion: @escaping (SheetOutcome) -> Void) {
        session?.cancel()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: SignInFlow.callbackScheme) { [weak self] callbackURL, error in
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
                guard let callbackURL = callbackURL,
                      callbackURL.scheme?.lowercased() == SignInFlow.callbackScheme,
                      callbackURL.host == "signed-in",
                      let ticket = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                        .queryItems?.first(where: { $0.name == "ticket" })?.value,
                      !ticket.isEmpty else {
                    self?.diagnostics.log("sheet", ["result": "no-ticket", "host": callbackURL?.host ?? ""])
                    completion(.failed("no ticket"))
                    return
                }
                self?.diagnostics.log("sheet", ["result": "ticket"])
                completion(.ticket(ticket))
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = ephemeral
        self.session = session
        diagnostics.log("sheet", ["result": "presenting", "url": Diagnostics.redact(url), "ephemeral": ephemeral])
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
