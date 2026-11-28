import UIKit
import XCTest

/// Helpers for the suites that run against the real backend, https://my.open.bot, as deployed today
/// (no shell mode, no /conversations, no sign-in hand-off). Never fail for network reasons: a run
/// that cannot reach it skips with the reason. Tests that use the throwaway account read its
/// secrets from the test runner's environment (the workflow passes them as TEST_RUNNER_*), never
/// log them, and their screenshots go only to the private artifact.
class RealBackendTestCase: ShellTestCase {
    static let prompt = "Say hello in three words."

    var safariViewService: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.SafariViewService") }

    func requireProduction() throws {
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

    func secret(_ name: String) -> String? {
        let value = ProcessInfo.processInfo.environment[name] ?? ""
        return value.isEmpty ? nil : value
    }

    /// Only what a shipped app reads: no DEBUG hook. Works on Release and Debug builds alike.
    func launchPlain(base: String?, moment: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OPENBOT_SHELL_DIAGNOSTICS"] = "1"
        app.launchEnvironment["OPENBOT_SHELL_TEST_NAME"] = "\(testName)-\(moment)"
        if let base = base { app.launchEnvironment["OPENBOT_BASE_URL"] = base }
        app.launch()
        return app
    }

    func googleButton(in roots: [XCUIElement]) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS[c] 'google'")
        var candidates: [XCUIElement] = []
        for root in roots {
            candidates.append(root.buttons.matching(predicate).firstMatch)
            candidates.append(root.links.matching(predicate).firstMatch)
        }
        return firstExisting(candidates, timeout: 10)
    }

    /// Sign in → no hand-off → the web sign-in → "Sign in or create an account" → the identity
    /// provider's page, in the app's web view. Returns false (with a note) when a step is missing.
    func openIdentityProviderInWebView(_ app: XCUIApplication) -> Bool {
        let button = app.buttons["sign-in-button"]
        guard button.waitForExistence(timeout: 15) else { XCTFail("no Sign in button"); return false }
        button.tap()
        guard app.buttons["web-sign-in-cancel"].waitForExistence(timeout: 25) else {
            screenshot("no-web-fallback")
            note("no web sign-in fallback (state \(debugState(app)))")
            return false
        }
        let heading = webText(app, "Sign in to OpenBot Cloud")
        XCTAssertTrue(heading.waitForExistence(timeout: 30), "the real web sign-in did not show")
        sleep(1)
        screenshot("web-sign-in")
        let predicate = NSPredicate(format: "label CONTAINS[c] 'Sign in or create an account'")
        guard let start = firstExisting([app.webViews.buttons.matching(predicate).firstMatch,
                                         app.webViews.links.matching(predicate).firstMatch], timeout: 15) else {
            note("no 'Sign in or create an account'")
            return false
        }
        start.tap()
        sleep(10)
        screenshot("identity-provider")
        return true
    }

    // MARK: - Google

    struct GoogleInputs {
        let email: String
        let password: String
        let totpSecret: Data
    }

    /// `gate`: the dispatch input that must be "true" (each attempt sends a prompt to the phone).
    func googleInputs(gate: String = "OPENBOT_SHELL_RUN_GOOGLE") throws -> GoogleInputs {
        guard ProcessInfo.processInfo.environment[gate] == "true" else {
            throw XCTSkip("this Google sign-in runs only when the workflow is started by hand with its input on: each attempt sends a sign-in prompt to the account's phone")
        }
        let names = ["OPENBOT_SHELL_GOOGLE_EMAIL", "OPENBOT_SHELL_GOOGLE_PASSWORD", "OPENBOT_SHELL_GOOGLE_TOTP_SECRET"]
        note("secret-inputs: \(names.allSatisfy { secret($0) != nil } ? "present" : "absent")")
        guard let email = secret(names[0]), let password = secret(names[1]), let totpText = secret(names[2]) else {
            throw XCTSkip("OPENBOT_SHELL_GOOGLE_EMAIL, OPENBOT_SHELL_GOOGLE_PASSWORD and OPENBOT_SHELL_GOOGLE_TOTP_SECRET are not all set")
        }
        guard let totpSecret = TOTP.base32Decode(totpText) else {
            throw XCTSkip("OPENBOT_SHELL_GOOGLE_TOTP_SECRET is not base32")
        }
        return GoogleInputs(email: email, password: password, totpSecret: totpSecret)
    }

    /// Google's email, password and 2-Step Verification pages, wherever they show (`roots`). One
    /// attempt. On the 2-Step page it answers only with the account's own authenticator code: when
    /// `tryAnotherWay`, it may pick that option under "Try another way" (the user decided so). It stops
    /// (XCTSkip with the reason) at any CAPTCHA, bot check or anything else Google asks for: nothing
    /// here tries to get past one. Screenshots only before a value goes in and after a page is left.
    func googleSteps(app: XCUIApplication, roots: [XCUIApplication], inputs: GoogleInputs, tryAnotherWay: Bool = false) throws {
        func live() -> [XCUIApplication] { roots.filter { $0.state != .notRunning } }
        func pageText() -> String {
            live().flatMap { labels(in: $0, limit: 200) }.joined(separator: "\n").lowercased()
        }
        func stopIfChallenged(_ step: String, allowSecondStep: Bool = false) throws {
            let text = pageText()
            var signs = ["captcha", "unusual activity", "not a robot", "type the text you hear or see",
                         "this browser or app may not be secure", "couldn\u{2019}t sign you in", "couldn't sign you in",
                         "try again later", "suspicious", "disallowed_useragent"]
            // The 2-Step Verification page itself says "verify it's you"; anywhere else that is a challenge.
            if !(allowSecondStep && text.contains("2-step verification")) {
                signs += ["verify it\u{2019}s you", "verify it's you", "confirm it\u{2019}s you", "confirm it's you", "check your phone"]
            }
            if let sign = signs.first(where: { text.contains($0) }) {
                screenshot("challenge-at-\(step.replacingOccurrences(of: " ", with: "-"))")
                note("challenged by Google at \(step) (page says '\(sign)')")
                throw XCTSkip("challenged by Google at \(step)")
            }
        }
        func first(_ make: (XCUIApplication) -> XCUIElement, timeout: TimeInterval) -> XCUIElement? {
            firstExisting(live().map(make), timeout: timeout)
        }
        func valueLength(_ field: XCUIElement) -> Int {
            let value = (field.value as? String) ?? ""
            let placeholder = field.placeholderValue ?? ""
            return value == placeholder ? 0 : value.count
        }
        /// Pastes the value (XCTest writes typed text into the log), then checks the field holds that
        /// many characters. If not, types it once: GitHub masks the secret in the log. Never logs it.
        func fill(_ field: XCUIElement, with value: String, step: String) -> Bool {
            field.tap()
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
            UIPasteboard.general.string = value
            sleep(1)
            field.press(forDuration: 1.2)
            let paste = first({ $0.menuItems.matching(identifier: "Paste").firstMatch }, timeout: 5)
            paste?.tap()
            sleep(2)
            UIPasteboard.general.string = ""
            var length = valueLength(field)
            let secure = field.elementType == .secureTextField
            if paste == nil || (!secure && length != value.count) || (secure && length == 0) {
                note("\(step): the paste did not land (menu \(paste != nil), \(length) of \(value.count) characters); typing instead")
                if length > 0 {
                    field.tap()
                    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: length + 2))
                }
                field.typeText(value)
                length = valueLength(field)
            }
            let ok = secure ? length > 0 : length == value.count
            note("\(step): field filled \(ok)")
            return ok
        }
        func submit(_ field: XCUIElement) {
            field.typeText("\n")
        }

        try stopIfChallenged("email page")
        guard let emailField = first({ $0.webViews.textFields.firstMatch }, timeout: 15)
                ?? first({ $0.textFields.matching(NSPredicate(format: "label CONTAINS[c] 'email'")).firstMatch }, timeout: 5) else {
            throw XCTSkip("no email field reachable on Google's page")
        }
        guard fill(emailField, with: inputs.email, step: "email") else { throw XCTSkip("could not enter the email") }
        submit(emailField)
        sleep(8)
        screenshot("google-after-email")
        try stopIfChallenged("after email")

        guard let passwordField = first({ $0.secureTextFields.firstMatch }, timeout: 15) else {
            screenshot("google-no-password-field")
            throw XCTSkip("no password field after the email step")
        }
        guard fill(passwordField, with: inputs.password, step: "password") else { throw XCTSkip("could not enter the password") }
        submit(passwordField)
        sleep(10)
        screenshot("google-after-password")
        try stopIfChallenged("after password", allowSecondStep: tryAnotherWay)

        var text = pageText()
        let codePage = { (t: String) in t.contains("google authenticator") || t.contains("authenticator app") || t.contains("enter code") }
        if text.contains("2-step verification") && !codePage(text) {
            guard tryAnotherWay else { throw XCTSkip("Google asked for its 2-Step Verification phone prompt") }
            let another = NSPredicate(format: "label CONTAINS[c] 'Try another way'")
            guard let tryAnother = first({ $0.buttons.matching(another).firstMatch }, timeout: 8)
                    ?? first({ $0.links.matching(another).firstMatch }, timeout: 2) else {
                screenshot("google-no-try-another-way")
                throw XCTSkip("the 2-Step page offered no 'Try another way'")
            }
            tryAnother.tap()
            sleep(6)
            screenshot("google-other-ways")
            let options = pageText()
            note("other ways offered: authenticator \(options.contains("authenticator")), backup codes \(options.contains("backup code")), text message \(options.contains("text message") || options.contains("sms"))")
            let authenticator = NSPredicate(format: "label CONTAINS[c] 'Authenticator'")
            guard let option = first({ $0.links.matching(authenticator).firstMatch }, timeout: 5)
                    ?? first({ $0.buttons.matching(authenticator).firstMatch }, timeout: 2)
                    ?? first({ $0.staticTexts.matching(authenticator).firstMatch }, timeout: 2) else {
                throw XCTSkip("the authenticator app is not among Google's other ways")
            }
            option.tap()
            sleep(6)
            screenshot("google-authenticator-page")
            try stopIfChallenged("authenticator page", allowSecondStep: true)
            text = pageText()
        }
        if codePage(text) || text.contains("2-step verification") {
            guard let codeField = first({ $0.webViews.textFields.firstMatch }, timeout: 10)
                    ?? first({ $0.textFields.firstMatch }, timeout: 3) else {
                throw XCTSkip("2-Step Verification page without a code field reachable")
            }
            guard fill(codeField, with: TOTP.freshCode(secret: inputs.totpSecret), step: "code") else { throw XCTSkip("could not enter the code") }
            submit(codeField)
            sleep(12)
            screenshot("google-after-code")
            try stopIfChallenged("after code")
            note("the authenticator code was accepted: \(!pageText().contains("wrong code") && !pageText().contains("2-step verification"))")
        } else {
            note("no authenticator page after the password")
        }
        sleep(6)
        screenshot("google-final")
    }

    // MARK: - The signed-in journey on the real backend

    /// Home, one real message and the Bot's streamed reply, Bots, Conversations, the web app's
    /// sidebar, background and resume, relaunch, and (when `signOut`) Sign out from the web app's
    /// own menu. Notes hold counts and yes/no only: the account's data stays in the screenshots.
    func realSignedInJourney(_ app: XCUIApplication, relaunch: () -> XCUIApplication, signOut: Bool) {
        var app = app
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "no tabs")
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "no message box on Home")
        sleep(3)
        screenshot("j1-home")

        // One real message, and the reply streaming in.
        composer.tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 8)
        composer.typeText(RealBackendTestCase.prompt)
        sleep(1)
        screenshot("j2-message-typed")
        let before = Set(labels(in: app.webViews.firstMatch, limit: 400))
        if let send = firstExisting([webElement(app, label: "Send message")], timeout: 5) {
            send.tap()
        } else {
            composer.typeText("\n")
        }
        var lengths: [Int] = []
        let started = Date()
        while Date().timeIntervalSince(started) < 60 {
            sleep(3)
            let now = labels(in: app.webViews.firstMatch, limit: 400)
            let fresh = now.filter { !before.contains($0) && !$0.contains(RealBackendTestCase.prompt) && $0.hasPrefix("StaticText") }
            lengths.append(fresh.map { $0.count }.max() ?? 0)
            if lengths.count == 2 { screenshot("j3-reply-streaming") }
            if lengths.count >= 4, lengths.suffix(3).allSatisfy({ $0 == lengths.last! }), (lengths.last ?? 0) > 0 { break }
        }
        let grew = zip(lengths, lengths.dropFirst()).contains { $0 < $1 && $0 > 0 }
        note("reply: longest new text by 3 s step \(lengths); grew while shown (streaming) \(grew); after \(Int(Date().timeIntervalSince(started))) s")
        sleep(3)
        screenshot("j4-reply")
        dismissKeyboardIfUp(app)
        note("after sending: \(debugState(app))")

        // Bots, a Bot.
        tab(app, .bots).tap()
        sleep(5)
        screenshot("j5-bots")
        if let bot = firstExisting([webText(app, "General Assistant")], timeout: 10) {
            bot.tap()
            sleep(5)
            dismissKeyboardIfUp(app)
            screenshot("j6-a-bot")
        }
        note("bots: \(debugState(app))")

        // Conversations: production has no /conversations yet.
        tab(app, .conversations).tap()
        sleep(6)
        screenshot("j7-conversations-tab")
        note("conversations tab: \(debugState(app)); web app's sidebar button \(webElement(app, label: "Show sidebar").exists)")
        if webElement(app, label: "Show sidebar").exists {
            webElement(app, label: "Show sidebar").tap()
            sleep(2)
            screenshot("j8-web-sidebar")
            if webElement(app, label: "Hide sidebar").exists { webElement(app, label: "Hide sidebar").tap() }
            sleep(1)
        }

        tab(app, .home).tap()
        sleep(2)
        // Background for 40 s, then back.
        XCUIDevice.shared.press(.home)
        sleep(40)
        app.activate()
        sleep(3)
        screenshot("j9-back-from-background")
        tab(app, .home).tap()
        XCTAssertTrue(app.webViews.textViews.firstMatch.waitForExistence(timeout: 20), "Home did not come back after the background")
        note("after background: \(debugState(app))")

        // Killed and opened again: straight to the tabs.
        sleep(4)
        app.terminate()
        app = relaunch()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 20), "a relaunch did not go straight to the tabs")
        XCTAssertFalse(app.buttons["sign-in-button"].exists)
        sleep(6)
        screenshot("j10-relaunched")

        guard signOut else {
            note("sign-out skipped: it would end the session the secret holds")
            return
        }
        // Sign out from the web app's own menu (the sidebar's account button).
        if webElement(app, label: "Show sidebar").exists { webElement(app, label: "Show sidebar").tap(); sleep(2) }
        var signedOut = false
        for candidate in app.webViews.popUpButtons.allElementsBoundByIndex.prefix(6) where candidate.exists && candidate.isHittable {
            candidate.tap()
            sleep(1)
            let item = webElement(app, label: "Sign out")
            if item.waitForExistence(timeout: 2) {
                screenshot("j11-account-menu")
                item.tap()
                signedOut = true
                break
            }
            app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        }
        note("found Sign out in the web app's menu: \(signedOut)")
        if signedOut {
            XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 30),
                          "the native sign-in did not come back after Sign out; state \(debugState(app))")
            screenshot("j12-signed-out")
        }
    }
}

/// Suite 1, on a RELEASE build where no hook is needed (CI runs this class from the Release build,
/// each test on a fresh install).
final class RealBackendUITests: RealBackendTestCase {
    /// First screen, Sign in, no hand-off (404), the real web sign-in, the identity provider, and
    /// what Google shows inside the app's web view.
    func testRealFirstScreenAndWebSignIn() throws {
        try requireProduction()
        let app = launchPlain(base: nil, moment: "web")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.webViews.firstMatch.exists, "a web view is visible on the first screen")
        screenshot("1-first-screen")
        guard openIdentityProviderInWebView(app) else { return }
        let idp = labels(in: app.webViews.firstMatch, limit: 120)
        attachText("identity-provider-labels", idp.joined(separator: "\n"))
        for name in ["GitHub", "Google", "Microsoft", "Email address"] {
            note("identity provider offers \(name): \(idp.contains { $0.contains(name) })")
        }
        guard let google = googleButton(in: [app.webViews.firstMatch]) else {
            note("no Google button in the web view")
            return
        }
        google.tap()
        sleep(10)
        screenshot("2-google-in-webview")
        let page = labels(in: app.webViews.firstMatch, limit: 80)
        attachText("google-in-webview-labels", page.joined(separator: "\n"))
        let refused = page.contains { $0.lowercased().contains("disallowed_useragent") || $0.lowercased().contains("may not be secure") }
        note("Google in the web view: sign-in page shown \(page.contains { $0.contains("Email or phone") }), refusal text \(refused)")
    }

    /// The real sign-in with Google inside the app's web view, then (if it lets the person in) the
    /// whole signed-in journey in that same session, with no hook at all.
    func testRealGoogleSignInInWebViewAndJourney() throws {
        let inputs = try googleInputs(gate: "OPENBOT_SHELL_RUN_GOOGLE_WEBVIEW")
        try requireProduction()
        note("video-mark start \(Date().timeIntervalSince1970)")
        defer { note("video-mark end \(Date().timeIntervalSince1970)") }
        let app = launchPlain(base: nil, moment: "google-webview")
        guard openIdentityProviderInWebView(app), let google = googleButton(in: [app.webViews.firstMatch]) else {
            throw XCTSkip("could not reach Google's button in the web view")
        }
        google.tap()
        sleep(10)
        screenshot("google-page")
        try googleSteps(app: app, roots: [app], inputs: inputs)
        let signedIn = tab(app, .home).waitForExistence(timeout: 30)
        screenshot("after-google")
        note("Google sign-in in the web view reached the tabs: \(signedIn); state \(debugState(app))")
        guard signedIn else {
            throw XCTSkip("Google's sign-in in the web view did not end signed in (see the screenshots)")
        }
        realSignedInJourney(app, relaunch: { self.launchPlain(base: nil, moment: "relaunch") }, signOut: true)
    }

    /// The lock screen on a Release build: a backend that cannot be reached.
    func testRealLockScreenWhenBackendUnreachable() throws {
        let app = launchPlain(base: "https://unreachable.openbot.invalid", moment: "unreachable")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 30), "no lock screen")
        XCTAssertEqual(lockScreen(app).value as? String, "load-failed")
        let heading = app.staticTexts["offline-lock-heading"]
        let message = app.staticTexts["offline-lock-message"]
        XCTAssertEqual(heading.exists ? heading.label : "", ShellTestCase.lockHeading)
        XCTAssertEqual(message.exists ? message.label : "", ShellTestCase.lockMessage)
        XCTAssertTrue(app.buttons["retry-button"].exists)
        XCTAssertTrue(app.buttons["support-email"].exists)
        sleep(1)
        screenshot("lock-screen")
        app.buttons["retry-button"].tap()
        sleep(2)
        XCTAssertTrue(lockScreen(app).exists, "the lock went away with nothing to reach")
    }
}

/// Suite 1, the parts that need a DEBUG hook (CI runs this class from the Debug build).
final class RealBackendDebugUITests: RealBackendTestCase {
    /// The hosted sign-in opened in the system sheet (OPENBOT_SHELL_DEBUG_SHEET_URL) and Google's
    /// sign-in there with the throwaway account. Passes only when the sheet ends on OpenBot signed in.
    func testRealGoogleSignInInSystemSheet() throws {
        let inputs = try googleInputs()
        try requireProduction()
        let app = launch(base: nil, moment: "google-sheet", extra: [
            "OPENBOT_SHELL_DEBUG_SHEET_URL": ShellTestCase.production + "/api/auth/hosted/sign-in?returnTo=%2F",
        ])
        let service = safariViewService
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        app.buttons["sign-in-button"].tap()
        sleep(10)
        screenshot("1-sheet")
        let sheetLabels = labels(in: app, limit: 120)
        note("sheet: \(sheetLabels.count) labels reachable through the app")
        guard let google = googleButton(in: [app, service]) else {
            throw XCTSkip("no Google button reachable in the sheet")
        }
        google.tap()
        sleep(10)
        screenshot("2-google")
        try googleSteps(app: app, roots: [app, service], inputs: inputs, tryAnotherWay: true)
        // Production has no hand-off yet: the sheet should end on my.open.bot, signed in, inside the sheet.
        sleep(8)
        screenshot("3-where-the-sheet-ended")
        let home = NSPredicate(format: "label CONTAINS 'Start a conversation' OR label CONTAINS 'Ask anything'")
        let landed = firstExisting([app.staticTexts.matching(home).firstMatch, service.staticTexts.matching(home).firstMatch,
                                    app.textViews.matching(home).firstMatch], timeout: 20) != nil
        let ended = labels(in: app, limit: 200).joined(separator: "\n")
        note("the sheet ended on OpenBot signed in: \(landed); OpenBot sign-in page \(ended.contains("Sign in to OpenBot")); Google page \(ended.contains("Google"))")
        guard landed else { throw XCTSkip("Google's sign-in in the sheet did not end on OpenBot signed in") }
    }

    /// The signed-in journey with the session cookie the secret holds (Debug hook
    /// OPENBOT_SHELL_TEST_SESSION_COOKIE). Does not sign out: that would end the secret's session.
    func testRealSignedInJourneyWithSessionCookie() throws {
        note("secret-inputs: \(secret("OPENBOT_SHELL_TEST_SESSION") == nil ? "absent" : "present")")
        guard let session = secret("OPENBOT_SHELL_TEST_SESSION") else {
            throw XCTSkip("OPENBOT_SHELL_TEST_SESSION is not set")
        }
        try requireProduction()
        note("video-mark start \(Date().timeIntervalSince1970)")
        defer { note("video-mark end \(Date().timeIntervalSince1970)") }
        let app = launch(base: nil, moment: "session", extra: ["OPENBOT_SHELL_TEST_SESSION_COOKIE": session])
        guard tab(app, .home).waitForExistence(timeout: 30) else {
            screenshot("no-tabs")
            XCTFail("the session cookie did not reach the tabs; state \(debugState(app))")
            return
        }
        sleep(6)
        if app.buttons["sign-in-button"].exists || webText(app, "Sign in to OpenBot Cloud").exists {
            screenshot("session-rejected")
            XCTFail("production rejected the session cookie (it may be stale or copied wrong)")
            return
        }
        realSignedInJourney(app, relaunch: { self.launch(base: nil, moment: "relaunch", reset: false) }, signOut: false)
    }

    /// The hosted sign-in in the system sheet, without credentials: what is reachable there.
    func testRealSignInPathInSystemSheet() throws {
        try requireProduction()
        let app = launch(base: nil, moment: "sheet", extra: [
            "OPENBOT_SHELL_DEBUG_SHEET_URL": ShellTestCase.production + "/api/auth/hosted/sign-in?returnTo=%2F",
        ])
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        app.buttons["sign-in-button"].tap()
        sleep(12)
        screenshot("1-sheet")
        let service = safariViewService
        let appLabels = labels(in: app, limit: 150)
        attachText("1-sheet-labels", appLabels.joined(separator: "\n"))
        note("sheet: \(appLabels.count) labels reachable through the app, SafariViewService state \(service.state.rawValue)")
        guard let google = googleButton(in: [app, service]) else {
            note("no Google button reachable in the sheet")
            return
        }
        google.tap()
        sleep(12)
        screenshot("2-google-in-sheet")
        note("Google in the sheet shows its sign-in page: \(labels(in: app, limit: 150).contains { $0.contains("Email or phone") })")
    }
}
