import XCTest

/// The hand-off config's decision, as pure logic (HandoffConfig.swift is compiled into this target
/// too). Launches nothing.
final class HandoffConfigTests: XCTestCase {
    private let host = "my.open.bot"

    private func decide(_ status: Int?, _ json: String?, https: Bool = true) -> HandoffMode {
        HandoffConfig.decide(status: status, body: json.map { Data($0.utf8) }, baseHost: host, httpsCallbackSupported: https)
    }

    func testNoAnswerIsUnreachable() {
        XCTAssertEqual(decide(nil, nil), .unreachable(reason: "no-answer"))
    }

    func testNotFoundAndOtherStatusesAreWebSignIn() {
        XCTAssertEqual(decide(404, "Not found"), .webSignIn(reason: "status-404"))
        XCTAssertEqual(decide(500, nil), .webSignIn(reason: "status-500"))
        XCTAssertEqual(decide(302, nil), .webSignIn(reason: "status-302"))
    }

    func testHandoffOff() {
        XCTAssertEqual(decide(200, #"{"handoff":false}"#), .webSignIn(reason: "handoff-off"))
    }

    func testSchemeCallback() {
        XCTAssertEqual(decide(200, #"{"handoff":true,"callback":"scheme","callbackUrl":"openbotshell://signed-in"}"#), .scheme)
        XCTAssertEqual(decide(200, #"{"handoff":true,"callback":"scheme","callbackUrl":"evil://signed-in"}"#),
                       .webSignIn(reason: "scheme-url-unexpected"))
    }

    func testHttpsCallback() {
        let json = #"{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot/api/auth/shell/callback"}"#
        XCTAssertEqual(decide(200, json), .https(host: "my.open.bot", path: "/api/auth/shell/callback"))
        XCTAssertEqual(decide(200, json, https: false), .webSignIn(reason: "https-callback-needs-ios-17.4"))
    }

    func testHttpsCallbackOnAnotherHostOrShapeIsRefused() {
        for url in ["https://evil.example/api/auth/shell/callback", "http://my.open.bot/api/auth/shell/callback",
                    "https://my.open.bot", "https://my.open.bot/", "https://my.open.bot:8443/cb",
                    "https://my.open.bot/cb?x=1", "not a url"] {
            let json = #"{"handoff":true,"callback":"https","callbackUrl":"\#(url)"}"#
            XCTAssertEqual(decide(200, json), .webSignIn(reason: "https-url-unexpected"), url)
        }
    }

    func testMalformedAnswers() {
        XCTAssertEqual(decide(200, "<html>"), .webSignIn(reason: "not-json-object"))
        XCTAssertEqual(decide(200, "[]"), .webSignIn(reason: "not-json-object"))
        XCTAssertEqual(decide(200, #"{"handoff":"true"}"#), .webSignIn(reason: "handoff-not-boolean"))
        XCTAssertEqual(decide(200, #"{"handoff":1}"#), .webSignIn(reason: "handoff-not-boolean"))
        XCTAssertEqual(decide(200, #"{"handoff":true}"#), .webSignIn(reason: "callback-missing"))
        XCTAssertEqual(decide(200, #"{"handoff":true,"callback":"carrier-pigeon","callbackUrl":"x"}"#), .webSignIn(reason: "callback-unknown"))
        XCTAssertEqual(decide(200, #"{"handoff":true,"callback":"scheme","callbackUrl":"openbotshell://signed-in","extra":1}"#), .scheme)
    }

    func testTicketFromCallback() {
        XCTAssertEqual(HandoffConfig.ticket(from: URL(string: "openbotshell://signed-in?ticket=abc"), mode: .scheme), "abc")
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "openbotshell://other?ticket=abc"), mode: .scheme))
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "openbotshell://signed-in"), mode: .scheme))
        let https = HandoffMode.https(host: "my.open.bot", path: "/api/auth/shell/callback")
        XCTAssertEqual(HandoffConfig.ticket(from: URL(string: "https://my.open.bot/api/auth/shell/callback?ticket=T1"), mode: https), "T1")
        // The server adds `platform`; only `ticket` is read, wherever it sits in the query.
        XCTAssertEqual(HandoffConfig.ticket(from: URL(string: "https://my.open.bot/api/auth/shell/callback?ticket=T1&platform=ios"), mode: https), "T1")
        XCTAssertEqual(HandoffConfig.ticket(from: URL(string: "https://my.open.bot/api/auth/shell/callback?platform=ios&ticket=T2"), mode: https), "T2")
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "https://my.open.bot/api/auth/shell/callback?platform=ios"), mode: https))
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "https://evil.example/api/auth/shell/callback?ticket=T1"), mode: https))
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "openbotshell://signed-in?ticket=T1"), mode: https))
    }
}

/// The hand-off URLs against the server contract's worked example (backend docs/shell-sign-in.md).
final class ShellURLsTests: XCTestCase {
    let base = URL(string: "https://my.open.bot")!

    func testEncodeKeepsOnlyUnreserved() {
        XCTAssertEqual(ShellURLs.encode("/bots/b1?tab=chat&openbot-renewed=1"), "%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1")
        XCTAssertEqual(ShellURLs.encode("aZ09-_.~"), "aZ09-_.~")
        XCTAssertEqual(ShellURLs.encode("a b+c/é"), "a%20b%2Bc%2F%C3%A9")
    }

    func testRenewalTargetFromTheContractsExample() {
        let intercepted = URL(string: "https://my.open.bot/api/auth/hosted/sign-in?returnTo=https%3A%2F%2Fmy.open.bot%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1")!
        let to = ShellURLs.renewalTarget(from: intercepted, baseHost: "my.open.bot")
        XCTAssertEqual(to, "/bots/b1?tab=chat&openbot-renewed=1")
        let enter = ShellURLs.enterURL(base: base, ticket: "T", verifier: "V", to: to)!.absoluteString
        XCTAssertEqual(enter, "https://my.open.bot/api/auth/shell/enter?ticket=T&verifier=V&to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1")
    }

    func testRenewalTargetFallsBackToRoot() {
        let other = URL(string: "https://my.open.bot/api/auth/hosted/sign-in?returnTo=https%3A%2F%2Fevil.example%2Fx")!
        XCTAssertEqual(ShellURLs.renewalTarget(from: other, baseHost: "my.open.bot"), "/")
        let missing = URL(string: "https://my.open.bot/api/auth/hosted/sign-in")!
        XCTAssertEqual(ShellURLs.renewalTarget(from: missing, baseHost: "my.open.bot"), "/")
        let relative = URL(string: "https://my.open.bot/api/auth/hosted/sign-in?returnTo=%2F%2Fevil.example")!
        XCTAssertEqual(ShellURLs.renewalTarget(from: relative, baseHost: "my.open.bot"), "/")
    }

    func testRenewalSheetURL() {
        let challenge = String(repeating: "a", count: 43)
        let path = ShellURLs.handoffPath(challenge: challenge, callback: "https")
        XCTAssertEqual(path, "/api/auth/shell/handoff?challenge=\(challenge)&platform=ios&callback=https")
        XCTAssertEqual(ShellURLs.renewalSheetURL(base: base, handoffPath: path)!.absoluteString,
                       "https://my.open.bot/api/auth/hosted/sign-in?returnTo=%2Fapi%2Fauth%2Fshell%2Fhandoff%3Fchallenge%3D\(challenge)%26platform%3Dios%26callback%3Dhttps")
    }
}

/// The edge swipe's decision from the page's `canGoBack`.
final class ShellBackTests: XCTestCase {
    func testNoFieldKeepsTheWebViewsOwnBack() {
        XCTAssertEqual(ShellBack.decide(canGoBack: nil), .webHistory)
        XCTAssertTrue(ShellBack.decide(canGoBack: nil).usesWebKitGesture)
    }

    func testDeeperThanTheRootSendsBackToThePage() {
        XCTAssertEqual(ShellBack.decide(canGoBack: true), .sendToPage)
        XCTAssertFalse(ShellBack.decide(canGoBack: true).usesWebKitGesture)
    }

    func testAtTheRootDoesNothing() {
        XCTAssertEqual(ShellBack.decide(canGoBack: false), .nothing)
        XCTAssertFalse(ShellBack.decide(canGoBack: false).usesWebKitGesture)
    }
}

/// A self-hosted OpenBot's address.
final class ServerAddressTests: XCTestCase {
    func parse(_ text: String, dev: Bool = false) -> String {
        switch ServerAddress.parse(text, allowDevelopmentHTTP: dev) {
        case .success(let url): return url.absoluteString
        case .failure(let problem): return "\(problem)"
        }
    }

    func testAcceptedForms() {
        XCTAssertEqual(parse("openbot.acme.com"), "https://openbot.acme.com")
        XCTAssertEqual(parse("  OpenBot.Acme.com/  "), "https://openbot.acme.com")
        XCTAssertEqual(parse("openbot.acme.com:8443"), "https://openbot.acme.com:8443")
        XCTAssertEqual(parse("https://openbot.acme.com/some/path?x=1"), "https://openbot.acme.com")
        XCTAssertEqual(parse("https://openbot.acme.com:443"), "https://openbot.acme.com")
    }

    func testRefused() {
        XCTAssertEqual(parse(""), "empty")
        XCTAssertEqual(parse("not an address"), "notAnAddress")
        XCTAssertEqual(parse("ftp://openbot.acme.com"), "notAnAddress")
        XCTAssertEqual(parse("https://me:secret@openbot.acme.com"), "credentials")
        XCTAssertEqual(parse("http://openbot.acme.com"), "insecure")
        XCTAssertEqual(parse("http://127.0.0.1:3014"), "insecure")
    }

    func testDevelopmentHTTPOnlyWhenAllowed() {
        XCTAssertEqual(parse("http://127.0.0.1:3014", dev: true), "http://127.0.0.1:3014")
        XCTAssertEqual(parse("http://openbot.acme.com", dev: true), "insecure")
        XCTAssertEqual(parse("http://box.test:3000", dev: true), "http://box.test:3000")
    }

    func testDisplay() {
        XCTAssertEqual(ServerAddress.display(URL(string: "https://openbot.acme.com")!), "openbot.acme.com")
        XCTAssertEqual(ServerAddress.display(URL(string: "https://openbot.acme.com:8443")!), "openbot.acme.com:8443")
    }
}
