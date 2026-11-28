import XCTest

/// Signing in to a self-hosted OpenBot instead of OpenBot Cloud. Cloud is mock stack A (3010); the
/// self-hosted OpenBot is mock stack C (3014, with the hand-off); mock stack B (3011, no hand-off:
/// its config answers 404) plays an OpenBot too old for the app. Debug builds accept http for local
/// development hosts only.
final class SelfHostedUITests: ShellTestCase {
    static let selfHosted = "http://127.0.0.1:3014"

    private func field(_ app: XCUIApplication) -> XCUIElement { app.textFields["server-address"] }
    private func error(_ app: XCUIApplication) -> XCUIElement { app.staticTexts["server-address-error"] }

    private func open(_ app: XCUIApplication) {
        let toggle = app.buttons["self-hosted-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20), "no quiet control for a self-hosted OpenBot")
        toggle.tap()
        XCTAssertTrue(field(app).waitForExistence(timeout: 5), "the address field did not open")
    }

    private func submit(_ app: XCUIApplication, _ text: String) {
        let box = field(app)
        box.tap()
        box.typeText(text)
        app.buttons["server-address-continue"].tap()
    }

    /// Cancel and open again: an empty field for the next address.
    private func reopen(_ app: XCUIApplication) {
        app.buttons["server-address-cancel"].tap()
        open(app)
    }

    // At rest no field; open: field and Continue above the keyboard; each kind of bad address has
    // its own sentence and the app stays on Cloud.
    func testAddressFieldAndRefusals() throws {
        let app = launch(base: ShellTestCase.mockA, moment: "rest")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20))
        XCTAssertFalse(field(app).exists, "the address field shows before the quiet control is tapped")
        sleep(1)
        screenshot("1-first-screen-at-rest")
        open(app)
        let keyboard = app.keyboards.firstMatch
        if keyboard.waitForExistence(timeout: 6) {
            XCTAssertLessThanOrEqual(field(app).frame.maxY, keyboard.frame.minY, "the keyboard covers the address field")
            XCTAssertLessThanOrEqual(app.buttons["server-address-continue"].frame.maxY, keyboard.frame.minY, "the keyboard covers Continue")
        }
        sleep(1)
        screenshot("2-expanded-with-keyboard")

        let cases: [(String, String, String)] = [
            ("not an address", "doesn't look like an address", "3-error-not-an-address"),
            ("http://openbot.acme.com", "only over https", "4-error-http"),
            ("http://127.0.0.1:3011", "isn't an OpenBot the phone app can use yet", "5-error-too-old"),
            ("http://127.0.0.1:3999", "didn't answer", "6-error-no-answer"),
        ]
        for (index, (typed, expected, shot)) in cases.enumerated() {
            if index > 0 { reopen(app) }
            submit(app, typed)
            XCTAssertTrue(error(app).waitForExistence(timeout: 15), "no error for \(typed)")
            XCTAssertTrue(error(app).label.contains(expected), "'\(typed)': \(error(app).label)")
            screenshot(shot)
        }
        app.buttons["server-address-cancel"].tap()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 5))
        XCTAssertEqual(stateValue(app, "server"), "127.0.0.1:3010", "a refused address changed the server")
    }

    // A good address: the first screen names it, Sign in reaches that OpenBot, it survives a
    // relaunch and a sign-out; the lock screen names it and Change address works; back to Cloud
    // clears its session and Sign in reaches Cloud.
    func testSelfHostedSignInAndBackToCloud() throws {
        var app = launch(base: ShellTestCase.mockA, moment: "choose", auto: true)
        open(app)
        submit(app, Self.selfHosted)
        let host = app.staticTexts["server-host"]
        XCTAssertTrue(host.waitForExistence(timeout: 20), "the first screen does not name the self-hosted OpenBot")
        XCTAssertTrue(host.label.contains("127.0.0.1:3014"), host.label)
        XCTAssertTrue(app.buttons["use-cloud"].exists, "no way back to OpenBot Cloud")
        sleep(1)
        screenshot("1-self-hosted-first-screen")

        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "signing in to the self-hosted OpenBot did not reach the tabs: \(debugState(app))")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        XCTAssertEqual(stateValue(app, "server"), "127.0.0.1:3014")
        screenshot("2-self-hosted-home")

        leaveAndTerminate(app)
        app = launch(base: ShellTestCase.mockA, moment: "relaunch", reset: false, auto: true)
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "after a relaunch the self-hosted session was gone")
        XCTAssertEqual(stateValue(app, "server"), "127.0.0.1:3014", "a relaunch forgot the self-hosted OpenBot")
        app.terminate()

        app = launch(base: ShellTestCase.mockA, moment: "lock", reset: false, auto: true,
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["offline-lock-host"].label.contains("127.0.0.1:3014"), "the lock screen does not name the host")
        sleep(1)
        screenshot("3-lock-with-host")
        app.buttons["change-address"].tap()
        XCTAssertTrue(field(app).waitForExistence(timeout: 5), "Change address did not open the field")
        XCTAssertEqual(field(app).value as? String, "http://127.0.0.1:3014", "the field does not hold the current address")
        screenshot("4-change-address")
        app.buttons["server-address-cancel"].tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 5), "Cancel did not return to the lock screen")
        app.terminate()

        // Sign out of the self-hosted OpenBot: its first screen.
        app = launch(base: ShellTestCase.mockA, moment: "sign-out", reset: false, auto: true)
        XCTAssertTrue(webElement(app, label: "Account").waitForExistence(timeout: 30))
        webElement(app, label: "Account").tap()
        XCTAssertTrue(webElement(app, label: "Sign out").waitForExistence(timeout: 5))
        webElement(app, label: "Sign out").tap()
        XCTAssertTrue(app.staticTexts["server-host"].waitForExistence(timeout: 20), "after sign-out the first screen is not the self-hosted one")

        // Back to Cloud: the default first screen; Sign in reaches Cloud.
        app.buttons["use-cloud"].tap()
        XCTAssertTrue(app.buttons["self-hosted-toggle"].waitForExistence(timeout: 20), "Use OpenBot Cloud did not bring back the default first screen")
        XCTAssertEqual(stateValue(app, "server"), "127.0.0.1:3010")
        screenshot("5-back-on-cloud")

        // Nothing of the self-hosted OpenBot survived: choosing it again starts signed out.
        open(app)
        submit(app, Self.selfHosted)
        XCTAssertTrue(app.staticTexts["server-host"].waitForExistence(timeout: 20))
        sleep(3)
        XCTAssertFalse(tab(app, .home).exists, "the self-hosted session survived the change to Cloud and back")
        XCTAssertEqual(stateValue(app, "phase"), "signedOut")
        app.buttons["use-cloud"].tap()
        XCTAssertTrue(app.buttons["self-hosted-toggle"].waitForExistence(timeout: 20))
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "signing in to Cloud did not reach the tabs")
        XCTAssertEqual(stateValue(app, "server"), "127.0.0.1:3010")
    }
}
