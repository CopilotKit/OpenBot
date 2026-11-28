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
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "https://evil.example/api/auth/shell/callback?ticket=T1"), mode: https))
        XCTAssertNil(HandoffConfig.ticket(from: URL(string: "openbotshell://signed-in?ticket=T1"), mode: https))
    }
}
