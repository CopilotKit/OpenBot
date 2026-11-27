import UIKit
import XCTest

/// What the real https://my.open.bot does with the shell. Never fails for network reasons: a run
/// that cannot reach it skips with the reason. Tests j and k use a real (throwaway) account and only
/// run when the test runner's environment has its secrets (the workflow passes them as
/// TEST_RUNNER_*); their screenshots never go into the general artifact.
final class ProductionUITests: ShellTestCase {
    private var safariViewService: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    }

    private func requireProduction() throws {
        var request = URLRequest(url: URL(string: ShellTestCase.production + "/")!)
        request.timeoutInterval = 15
        let done = expectation(description: "my.open.bot answers")
        var status = -1
        var failure = ""
        URLSession.shared.dataTask(with: request) { _, response, error in
            status = (response as? HTTPURLResponse)?.statusCode ?? -1
            failure = error.map { ($0 as NSError).domain + " " + String(($0 as NSError).code) } ?? ""
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        if status <= 0 || status >= 500 {
            throw XCTSkip("my.open.bot is not reachable from this runner (status \(status) \(failure))")
        }
    }

    private func secret(_ name: String) -> String? {
        let value = ProcessInfo.processInfo.environment[name] ?? ""
        return value.isEmpty ? nil : value
    }

    /// Labels of everything visible in a tree, for the record (public pages only).
    private func labels(_ element: XCUIElement, limit: Int = 150) -> [String] {
        var result: [String] = []
        for child in element.descendants(matching: .any).allElementsBoundByIndex.prefix(500) {
            let label = child.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty { result.append("\(child.elementType.rawValue): \(label)") }
            if result.count >= limit { break }
        }
        return result
    }

    private func googleButton(in roots: [XCUIElement]) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS[c] 'google'")
        var candidates: [XCUIElement] = []
        for root in roots {
            candidates.append(root.buttons.matching(predicate).firstMatch)
            candidates.append(root.links.matching(predicate).firstMatch)
        }
        return firstExisting(candidates, timeout: 10)
    }

    // h.
    func testProductionSignInPathInWebView() throws {
        try requireProduction()
        let app = launch(base: nil, moment: "web")
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()

        let cancel = app.buttons["web-sign-in-cancel"]
        if !cancel.waitForExistence(timeout: 25) {
            screenshot("no-fallback")
            note("no web sign-in fallback: the hand-off probe may have answered (state \(debugState(app)))")
            if safariViewService.state == .runningForeground { note("a sign-in sheet opened: production has the hand-off") }
            return
        }
        note("hand-off probe: no hand-off on my.open.bot, web fallback shown")
        let heading = webText(app, "Sign in to OpenBot Cloud")
        let headingShown = heading.waitForExistence(timeout: 30)
        sleep(2)
        screenshot("1-web-sign-in")
        attachText("1-web-sign-in-labels", webLabels(app).joined(separator: "\n"))
        XCTAssertTrue(headingShown, "the web sign-in did not say 'Sign in to OpenBot Cloud'")

        let predicate = NSPredicate(format: "label CONTAINS[c] 'Sign in or create an account'")
        guard let start = firstExisting([app.webViews.buttons.matching(predicate).firstMatch,
                                         app.webViews.links.matching(predicate).firstMatch], timeout: 15) else {
            note("no 'Sign in or create an account' control")
            return
        }
        start.tap()
        sleep(12)
        screenshot("2-identity-provider")
        let idpLabels = webLabels(app, limit: 150)
        attachText("2-identity-provider-labels", idpLabels.joined(separator: "\n"))
        for line in idpLabels.prefix(40) { note("idp: \(line)") }

        guard let google = googleButton(in: [app.webViews.firstMatch]) else {
            note("no Google button on the identity provider's page in the web view")
            return
        }
        note("tapping '\(google.label)' in the web view")
        google.tap()
        sleep(12)
        screenshot("3-google-in-webview")
        let googleLabels = webLabels(app, limit: 80)
        attachText("3-google-in-webview-labels", googleLabels.joined(separator: "\n"))
        for line in googleLabels.prefix(25) { note("google-webview: \(line)") }
        note("state after Google: \(debugState(app))")
    }

    // i.
    func testProductionSignInPathInSystemSheet() throws {
        try requireProduction()
        let app = launch(base: nil, moment: "sheet", extra: [
            "OPENBOT_SHELL_DEBUG_SHEET_URL": ShellTestCase.production + "/api/auth/hosted/sign-in?returnTo=%2F",
        ])
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        sleep(12)
        screenshot("1-sheet")
        let appLabels = labels(app)
        let serviceLabels = safariViewService.state == .notRunning ? [] : labels(safariViewService)
        attachText("1-sheet-app-labels", appLabels.joined(separator: "\n"))
        attachText("1-sheet-safariviewservice-labels", serviceLabels.joined(separator: "\n"))
        note("sheet: \(appLabels.count) labels reachable through the app, \(serviceLabels.count) through SafariViewService (state \(safariViewService.state.rawValue))")
        for line in (appLabels + serviceLabels).prefix(40) { note("sheet: \(line)") }

        guard let google = googleButton(in: [app, safariViewService]) else {
            note("no Google button reachable in the sheet")
            return
        }
        note("tapping '\(google.label)' in the sheet")
        google.tap()
        sleep(12)
        screenshot("2-google-in-sheet")
        let after = labels(app, limit: 80) + (safariViewService.state == .notRunning ? [] : labels(safariViewService, limit: 80))
        attachText("2-google-in-sheet-labels", after.joined(separator: "\n"))
        for line in after.prefix(25) { note("google-sheet: \(line)") }
    }

    // j.
    func testProductionSignedIn() throws {
        guard let session = secret("OPENBOT_SHELL_TEST_SESSION") else {
            throw XCTSkip("OPENBOT_SHELL_TEST_SESSION is not set")
        }
        try requireProduction()
        let app = launch(base: nil, moment: "session", extra: ["OPENBOT_SHELL_TEST_SESSION_COOKIE": session])
        let home = tab(app, .home)
        guard home.waitForExistence(timeout: 30) else {
            screenshot("no-tabs")
            XCTFail("the injected session did not reach the tabs; state \(debugState(app))")
            return
        }
        sleep(10)
        screenshot("1-home")
        note("home: \(debugState(app))")
        if app.buttons["sign-in-button"].exists {
            note("production signed the session out (sign-in screen back)")
            return
        }
        tab(app, .bots).tap()
        sleep(6)
        screenshot("2-bots")
        note("bots: \(debugState(app))")
        tab(app, .conversations).tap()
        sleep(6)
        screenshot("3-conversations")
        note("conversations: \(debugState(app))")
        tab(app, .home).tap()
        sleep(5)
        let conversationLink = app.webViews.links.matching(NSPredicate(format: "value CONTAINS '/channel/'")).firstMatch
        if conversationLink.waitForExistence(timeout: 5) {
            conversationLink.tap()
            sleep(6)
            screenshot("4-conversation")
            note("conversation: \(debugState(app))")
        } else {
            note("no link to a conversation found on Home")
            screenshot("4-no-conversation-link")
        }
    }

    // k.
    /// One attempt per run. Stops (skipped, with the reason) at the first CAPTCHA, "verify it's you"
    /// prompt or any other challenge: nothing here tries to get past one. Screenshots are taken
    /// before a value is filled in and after the page is left, never while a value shows.
    func testProductionGoogleSignIn() throws {
        guard let email = secret("OPENBOT_SHELL_GOOGLE_EMAIL"),
              let password = secret("OPENBOT_SHELL_GOOGLE_PASSWORD"),
              let totpText = secret("OPENBOT_SHELL_GOOGLE_TOTP_SECRET") else {
            throw XCTSkip("OPENBOT_SHELL_GOOGLE_EMAIL, OPENBOT_SHELL_GOOGLE_PASSWORD and OPENBOT_SHELL_GOOGLE_TOTP_SECRET are not all set")
        }
        guard let totpSecret = TOTP.base32Decode(totpText) else {
            throw XCTSkip("OPENBOT_SHELL_GOOGLE_TOTP_SECRET is not base32")
        }
        try requireProduction()
        let app = launch(base: nil, moment: "google", extra: [
            "OPENBOT_SHELL_DEBUG_SHEET_URL": ShellTestCase.production + "/api/auth/hosted/sign-in?returnTo=%2F",
        ])
        let service = safariViewService
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        sleep(10)
        screenshot("1-sheet")
        guard let google = googleButton(in: [app, service]) else {
            note("no Google button reachable in the sheet; stopped")
            return
        }
        google.tap()
        sleep(10)
        screenshot("2-google")

        func pageText() -> String {
            var roots: [XCUIElement] = [app]
            if service.state != .notRunning { roots.append(service) }
            return roots.flatMap { labels($0, limit: 200) }.joined(separator: "\n").lowercased()
        }
        /// Stops the test at any challenge.
        func stopIfChallenged(_ step: String) throws {
            let text = pageText()
            let signs = ["captcha", "verify it\u{2019}s you", "verify it's you", "confirm it\u{2019}s you", "confirm it's you",
                         "unusual activity", "not a robot", "type the text you hear or see", "check your phone",
                         "this browser or app may not be secure", "couldn\u{2019}t sign you in", "couldn't sign you in",
                         "try again later", "suspicious"]
            if let sign = signs.first(where: { text.contains($0) }) {
                screenshot("challenge-at-\(step)")
                note("challenged by Google at \(step) (page says '\(sign)')")
                throw XCTSkip("challenged by Google at \(step)")
            }
        }
        // Values go in through the pasteboard, never typeText: XCTest writes typed text to the log.
        func fill(_ field: XCUIElement, with value: String, step: String) -> Bool {
            UIPasteboard.general.string = value
            field.tap()
            sleep(1)
            field.press(forDuration: 1.2)
            let paste = firstExisting([app.menuItems["Paste"], service.menuItems["Paste"],
                                       app.buttons["Paste"], service.buttons["Paste"]], timeout: 5)
            if paste == nil { note("\(step): no Paste menu") }
            paste?.tap()
            UIPasteboard.general.string = ""
            return paste != nil
        }
        func next() {
            if let nextButton = firstExisting([app.buttons["Next"], service.buttons["Next"]], timeout: 5) {
                nextButton.tap()
            }
        }

        try stopIfChallenged("email page")
        guard let emailField = firstExisting([app.textFields.firstMatch, service.textFields.firstMatch], timeout: 15) else {
            note("no email field reachable on Google's page")
            return
        }
        guard fill(emailField, with: email, step: "email") else { return }
        next()
        sleep(8)
        screenshot("3-after-email")
        try stopIfChallenged("after email")

        guard let passwordField = firstExisting([app.secureTextFields.firstMatch, service.secureTextFields.firstMatch], timeout: 15) else {
            screenshot("3-no-password-field")
            note("no password field after the email step")
            return
        }
        guard fill(passwordField, with: password, step: "password") else { return }
        next()
        sleep(10)
        screenshot("4-after-password")
        try stopIfChallenged("after password")

        // 2-Step Verification: only the authenticator code page is answered.
        let text = pageText()
        if text.contains("authenticator") || text.contains("enter code") || text.contains("2-step verification") {
            guard let codeField = firstExisting([app.textFields.firstMatch, service.textFields.firstMatch], timeout: 10) else {
                note("2-Step Verification page without a code field reachable; stopped")
                return
            }
            guard fill(codeField, with: TOTP.freshCode(secret: totpSecret), step: "code") else { return }
            next()
            sleep(12)
            screenshot("5-after-code")
            try stopIfChallenged("after code")
        } else {
            note("no authenticator page after the password")
        }
        sleep(8)
        screenshot("6-final")
        let host = service.state != .notRunning ? "SafariViewService running" : "SafariViewService not running"
        note("finished the Google steps (\(host)); state \(debugState(app))")
    }
}
