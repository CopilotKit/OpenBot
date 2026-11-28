import XCTest

/// Runs against a RELEASE build: no DEBUG hook exists in the app, and App Transport Security has no
/// exception. The only launch environment set is what a shipped app also reads (OPENBOT_BASE_URL,
/// OPENBOT_SHELL_DIAGNOSTICS, OPENBOT_SHELL_TEST_NAME). CI uninstalls the app before each test, so
/// every test starts from a fresh install, and runs each one in its own xcodebuild invocation.
///
/// The mock is reached at https://shell-test.openbot.test (ci/tls-proxy.ts, with a CA the simulator
/// trusts), where it sets production's `__Secure-better-auth.session_token`.
final class ReleaseUITests: ShellTestCase {
    static let httpsMock = "https://shell-test.openbot.test"
    /// The same stack, started 8 s after the test writes the trigger file (CI).
    static let lateHttpsMock = "https://shell-test.openbot.test:8444"

    private func launchRelease(base: String?, moment: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OPENBOT_SHELL_DIAGNOSTICS"] = "1"
        app.launchEnvironment["OPENBOT_SHELL_TEST_NAME"] = "\(testName)-\(moment)"
        if let base = base { app.launchEnvironment["OPENBOT_BASE_URL"] = base }
        app.launch()
        return app
    }

    func testReleaseFirstScreenIsNative() throws {
        let app = launchRelease(base: ReleaseUITests.httpsMock, moment: "first")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15), "no native Sign in button")
        XCTAssertFalse(app.webViews.firstMatch.exists, "a web view is visible on the first screen")
        XCTAssertFalse(app.staticTexts["debug-state"].exists, "a DEBUG-only element is in the Release build")
        screenshot("first-screen")
    }

    /// Sign in through the sheet by hand (consent alert, the mock's link), tabs, a conversation,
    /// relaunch, then Account, Sign out.
    func testReleaseJourney() throws {
        var app = launchRelease(base: ReleaseUITests.httpsMock, moment: "journey")
        let signIn = app.buttons["sign-in-button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        signIn.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if let consent = firstExisting([springboard.alerts.buttons["Continue"], springboard.buttons["Continue"]], timeout: 15) {
            screenshot("1-consent-alert")
            consent.tap()
        } else {
            note("no consent alert appeared")
        }
        let link = app.webViews.links["Sign in as test person"]
        XCTAssertTrue(link.waitForExistence(timeout: 20), "the sheet's link was not reachable")
        screenshot("2-sheet")
        link.tap()

        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "no tabs after signing in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30), "Home did not render")
        sleep(2)
        screenshot("3-home")
        assertNoWebNavigation(app, "home")

        tab(app, .conversations).tap()
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 20), "Conversations did not list")
        XCTAssertTrue(tab(app, .conversations).isSelected)
        screenshot("4-conversations")
        assertNoWebNavigation(app, "conversations")
        webText(app, "Quarterly forecast").tap()
        let transcript = firstExisting([webText(app, "Here is the first draft."),
                                        webText(app, "Can you draft the quarterly forecast?")], timeout: 25)
        XCTAssertNotNil(transcript, "the conversation did not open")
        dismissKeyboardIfUp(app, tapping: transcript)
        XCTAssertTrue(tab(app, .conversations).waitForExistence(timeout: 5))
        XCTAssertTrue(tab(app, .conversations).isSelected)
        sleep(1)
        screenshot("5-conversation")

        tab(app, .bots).tap()
        XCTAssertTrue(webText(app, "Research Bot").waitForExistence(timeout: 20), "Bots did not list")
        screenshot("6-bots")

        // The Secure session cookie survives a relaunch.
        sleep(5)
        app.terminate()
        app = launchRelease(base: ReleaseUITests.httpsMock, moment: "relaunch")
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 20), "a relaunch did not go straight to the tabs")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        screenshot("7-relaunch")

        let account = webElement(app, label: "Account")
        XCTAssertTrue(account.waitForExistence(timeout: 10), "no Account button")
        account.tap()
        guard let signOut = firstExisting([webElement(app, label: "Sign out")], timeout: 10) else {
            XCTFail("no Sign out in the Account menu")
            return
        }
        screenshot("8-account-menu")
        signOut.tap()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20), "Sign out did not return to the native sign-in")
        screenshot("9-signed-out")
    }

    /// No server yet: the lock screen; then the server comes up and it lifts by itself.
    func testReleaseLockLiftsWhenServerComesBack() throws {
        guard let trigger = ProcessInfo.processInfo.environment["OPENBOT_SHELL_LATE_HTTPS_TRIGGER"], !trigger.isEmpty else {
            throw XCTSkip("OPENBOT_SHELL_LATE_HTTPS_TRIGGER is not set (CI sets it)")
        }
        let app = launchRelease(base: ReleaseUITests.lateHttpsMock, moment: "late")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        XCTAssertTrue(FileManager.default.createFile(atPath: trigger, contents: Data("go\n".utf8)))
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 30), "no lock screen while the server is down")
        XCTAssertEqual(lockScreen(app).value as? String, "load-failed")
        XCTAssertTrue(app.buttons["retry-button"].exists)
        screenshot("1-lock")
        XCTAssertTrue(lockScreen(app).waitForNonExistence(timeout: 60), "the lock did not lift when the server came up")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 10))
        screenshot("2-lifted")
    }

    /// The real site: first screen, then Sign in: no hand-off (404), the web sign-in.
    func testReleaseProductionWebFallback() throws {
        let app = launchRelease(base: nil, moment: "production")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        screenshot("1-first-screen")
        app.buttons["sign-in-button"].tap()
        guard app.buttons["web-sign-in-cancel"].waitForExistence(timeout: 25) else {
            screenshot("no-fallback")
            if lockScreen(app).exists { throw XCTSkip("my.open.bot did not answer from this runner (lock screen)") }
            XCTFail("no web sign-in fallback")
            return
        }
        let shown = webText(app, "Sign in to OpenBot Cloud").waitForExistence(timeout: 30)
        sleep(2)
        screenshot("2-web-sign-in")
        XCTAssertTrue(shown, "the real web sign-in page did not show")
    }
}
