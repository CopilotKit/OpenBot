import XCTest

/// The shell's own screens and flows against the mock stacks (see ShellTestCase).
final class ShellFlowUITests: ShellTestCase {
    private static let sheetLinkLabel = "Sign in as test person"

    // a.
    func testFirstScreenIsNative() throws {
        var app = launch(base: ShellTestCase.mockA, moment: "mock")
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15), "no native Sign in button")
        XCTAssertTrue(app.staticTexts["OpenBot"].exists, "the first screen does not say OpenBot")
        XCTAssertFalse(app.webViews.firstMatch.exists, "a web view is visible on the first screen")
        XCTAssertFalse(tab(app, .home).exists, "the tab bar shows before signing in")
        screenshot("first-screen")
        app.terminate()
        app = launch(base: ShellTestCase.mockA, moment: "dark", extra: ["OPENBOT_SHELL_FORCE_DARK": "1"])
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
        sleep(1)
        screenshot("first-screen-dark")
        app.terminate()

        // Nothing listens on 8799: the first screen does not need the server.
        app = launch(base: "http://127.0.0.1:8799", moment: "unreachable")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15),
                      "no native Sign in button with an unreachable server")
        XCTAssertFalse(app.webViews.firstMatch.exists)
        screenshot("first-screen-unreachable-server")

        // Sign in there: the hand-off probe gets no answer, so the lock screen shows (load-failed).
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 30), "no lock screen after a sign-in with no server")
        sleep(1)
        screenshot("unreachable-server-after-sign-in")
        assertLockScreen(app, reason: "load-failed")
        note("unreachable server after Sign in: \(debugState(app))")
    }

    // The lock screen lifts by itself when OpenBot comes back. CI starts a third stack on 3012
    // (over mock A's server) 8 s after this test writes the trigger file it names.
    func testLockLiftsWhenServerComesBack() throws {
        guard let trigger = ProcessInfo.processInfo.environment["OPENBOT_SHELL_LATE_STACK_TRIGGER"], !trigger.isEmpty else {
            throw XCTSkip("OPENBOT_SHELL_LATE_STACK_TRIGGER is not set (CI sets it)")
        }
        // A session the server does not know: the app starts signed in and loads Home from 3012.
        let wrote = FileManager.default.createFile(atPath: trigger, contents: Data("go\n".utf8))
        XCTAssertTrue(wrote, "could not write the trigger file")
        let app = launch(base: "http://127.0.0.1:3012", moment: "late", extra: ["OPENBOT_SHELL_TEST_STALE_SESSION": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15), "no lock screen while the server is down")
        sleep(1)
        screenshot("1-lock-while-server-down")
        assertLockScreen(app, reason: "load-failed")
        XCTAssertTrue(lockScreen(app).waitForNonExistence(timeout: 60), "the lock did not lift when the server came up; \(debugState(app))")
        // The page loads, says nobody is signed in, and the native sign-in comes back.
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 30), "no sign-in screen after recovery; \(debugState(app))")
        sleep(1)
        screenshot("2-after-server-came-back")
        note("after recovery: \(debugState(app))")
    }

    // b.
    func testNativeSignInThroughSheet() throws {
        var app = launch(base: ShellTestCase.mockA, moment: "manual")
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()

        // Try to reach the sheet's page: from the app's own tree, then from SafariViewService.
        let safariViewService = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let candidates = [
            app.webViews.links[ShellFlowUITests.sheetLinkLabel],
            app.links[ShellFlowUITests.sheetLinkLabel],
            safariViewService.webViews.links[ShellFlowUITests.sheetLinkLabel],
            safariViewService.links[ShellFlowUITests.sheetLinkLabel],
        ]
        let found = firstExisting(candidates, timeout: 20)
        sleep(1)
        screenshot("sheet")
        attachText("sheet-app-tree", String(app.debugDescription.prefix(20000)))
        if found == nil {
            if safariViewService.state != .notRunning {
                attachText("sheet-safariviewservice-tree", String(safariViewService.debugDescription.prefix(20000)))
            }
            note("the sheet's page was NOT reachable from XCUITest (app or SafariViewService); using the mock's auto=1")
            app.terminate()
            app = launch(base: ShellTestCase.mockA, moment: "auto", auto: true)
            XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 15))
            app.buttons["sign-in-button"].tap()
            sleep(1)
            screenshot("sheet-auto")
        } else {
            let index = candidates.firstIndex { $0 == found } ?? -1
            note("the sheet's link was reachable through candidate \(index) (0-1 app, 2-3 SafariViewService)")
            found?.tap()
        }

        let home = tab(app, .home)
        XCTAssertTrue(home.waitForExistence(timeout: 45), "the tabs never appeared; state \(debugState(app))")
        let homeText = webText(app, "Start a conversation")
        XCTAssertTrue(homeText.waitForExistence(timeout: 30), "the signed-in Home did not render")
        sleep(2)
        screenshot("signed-in-home")
        checkTabBar(app)
        XCTAssertTrue(home.isSelected, "Home is not the selected tab")
        XCTAssertFalse(app.buttons["sign-in-button"].exists, "the sign-in screen is still there")
        assertNoWebNavigation(app, "home")
        note("after sign-in: \(debugState(app))")

        // The session cookie survives a relaunch: straight to the tabs.
        sleep(5)
        app.terminate()
        app = launch(base: ShellTestCase.mockA, moment: "relaunch", reset: false)
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 20), "a relaunch did not go straight to the tabs")
        XCTAssertFalse(app.buttons["sign-in-button"].exists, "a relaunch showed the sign-in screen")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30), "Home did not render after relaunch")
        screenshot("relaunch-signed-in")
    }

    // b, non-ephemeral: iOS asks the person before the sheet opens.
    func testNativeSignInWithConsentAlert() throws {
        let app = launch(base: ShellTestCase.mockA, moment: "consent", ephemeral: false, auto: true)
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let continueButton = firstExisting([
            springboard.alerts.buttons["Continue"],
            springboard.buttons["Continue"],
            app.alerts.buttons["Continue"],
        ], timeout: 15)
        screenshot("consent-alert")
        if let continueButton = continueButton {
            if let alert = springboard.alerts.allElementsBoundByIndex.first {
                note("consent alert: \(alert.label)")
            }
            continueButton.tap()
        } else {
            note("no consent alert appeared (non-ephemeral)")
            attachText("consent-springboard-tree", String(springboard.debugDescription.prefix(10000)))
        }
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "the tabs never appeared; state \(debugState(app))")
        screenshot("signed-in-after-consent")
    }

    // c.
    func testTabsRouteTheWebView() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30), "Home did not render")
        sleep(2)
        let commitsAtStart = stateValue(app, "commits") ?? "?"
        screenshot("1-home")
        assertNoWebNavigation(app, "home")
        XCTAssertTrue(accountButton(app).waitForExistence(timeout: 10), "no Account button on Home")

        tab(app, .conversations).tap()
        for title in ["Competitor pricing notes", "Quarterly forecast", "Trip to Lisbon"] {
            XCTAssertTrue(webText(app, title).waitForExistence(timeout: 20), "Conversations does not list '\(title)'")
        }
        XCTAssertTrue(tab(app, .conversations).isSelected)
        XCTAssertTrue(waitForState(app, "nav=event", timeout: 5), "the Conversations tap was not handled by openbot:open: \(debugState(app))")
        sleep(1)
        screenshot("2-conversations")
        app.webViews.firstMatch.swipeUp()
        app.webViews.firstMatch.swipeUp()
        sleep(1)
        screenshot("2b-conversations-scrolled-to-end")
        app.webViews.firstMatch.swipeDown()
        app.webViews.firstMatch.swipeDown()
        assertNoWebNavigation(app, "conversations")
        XCTAssertTrue(accountButton(app).exists, "no Account button on Conversations")

        webText(app, "Quarterly forecast").tap()
        let transcript = firstExisting([
            webText(app, "Here is the first draft."),
            webText(app, "Can you draft the quarterly forecast?"),
        ], timeout: 25)
        XCTAssertNotNil(transcript, "the conversation did not open")
        sleep(1)
        if app.keyboards.firstMatch.exists {
            // Finding for the web app: in the shell a conversation focuses its message box on open,
            // which raises the keyboard (and so hides the tab bar).
            screenshot("3a-conversation-opened-with-keyboard")
            note("opening a conversation raised the keyboard (the message box took focus)")
        }
        dismissKeyboardIfUp(app, tapping: transcript)
        XCTAssertTrue(tab(app, .conversations).waitForExistence(timeout: 5), "no tab bar in the conversation")
        XCTAssertTrue(tab(app, .conversations).isSelected, "opening a conversation moved the tab selection")
        sleep(1)
        screenshot("3-conversation")
        let messageBox = firstExisting([app.webViews.textViews.firstMatch, app.webViews.textFields.firstMatch], timeout: 10)
        let bar = app.tabBars.firstMatch
        XCTAssertNotNil(messageBox, "no message box in the conversation")
        if let messageBox = messageBox, bar.exists {
            XCTAssertLessThanOrEqual(messageBox.frame.maxY, bar.frame.minY + 1, "the message box is under the tab bar")
            XCTAssertTrue(messageBox.isHittable, "the message box cannot be tapped")
            note("conversation: message box \(messageBox.frame), tab bar \(bar.frame)")
        }
        assertNoWebNavigation(app, "conversation")

        tab(app, .bots).tap()
        for name in ["General Assistant", "Research Bot"] {
            XCTAssertTrue(webText(app, name).waitForExistence(timeout: 20), "Bots does not list '\(name)'")
        }
        XCTAssertTrue(tab(app, .bots).isSelected)
        sleep(1)
        screenshot("4-bots")
        assertNoWebNavigation(app, "bots")
        XCTAssertTrue(accountButton(app).exists, "no Account button on Bots")

        tab(app, .home).tap()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 20), "Home did not come back")
        XCTAssertTrue(tab(app, .home).isSelected)
        sleep(1)
        screenshot("5-home-again")
        let commitsAtEnd = stateValue(app, "commits") ?? "?"
        XCTAssertEqual(commitsAtStart, commitsAtEnd, "a tab tap reloaded the page (main-frame commits changed)")
        note("commits start \(commitsAtStart) end \(commitsAtEnd); \(debugState(app))")

        // Dark mode: the page follows the system, and the chrome follows the page.
        sleep(3)
        app.terminate()
        let dark = launch(base: ShellTestCase.mockA, moment: "dark", reset: false, extra: ["OPENBOT_SHELL_FORCE_DARK": "1"])
        XCTAssertTrue(tab(dark, .home).waitForExistence(timeout: 20), "no tabs in dark mode")
        XCTAssertTrue(webText(dark, "Start a conversation").waitForExistence(timeout: 20))
        sleep(2)
        screenshot("6-home-dark")
        note("dark: \(debugState(dark))")
        XCTAssertTrue(waitForState(dark, "dark=1", timeout: 5), "the page did not report dark mode: \(debugState(dark))")
        tab(dark, .conversations).tap()
        sleep(2)
        screenshot("7-conversations-dark")
    }

    // d.
    func testSignedOutByServerReturnsToNativeSignIn() throws {
        var app = launchSignedIn(moment: "sign-in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        sleep(4)
        app.terminate()

        // The session ran out on the server: the cookie is still there, the server no longer knows it.
        app = launch(base: ShellTestCase.mockA, moment: "stale", reset: false,
                     extra: ["OPENBOT_SHELL_TEST_STALE_SESSION": "1"])
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "the native sign-in did not come back; state \(debugState(app))")
        XCTAssertTrue(tab(app, .home).waitForNonExistence(timeout: 5), "the tab bar stayed")
        sleep(1)
        screenshot("native-sign-in-after-session-ended")
        note("after the server ended the session: \(debugState(app))")
        app.terminate()

        // The shell deleted the dead cookie: the next launch starts signed out at once.
        app = launch(base: ShellTestCase.mockA, moment: "after", reset: false)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 10))
        sleep(3)
        XCTAssertFalse(tab(app, .home).exists, "the next launch still thought it was signed in")
        screenshot("next-launch")
    }

    // d, from the page: Account, then Sign out.
    func testSignOutFromAccountMenu() throws {
        var app = launchSignedIn(moment: "sign-in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        let account = accountButton(app)
        XCTAssertTrue(account.waitForExistence(timeout: 10), "no Account button on Home")
        account.tap()
        let signOut = firstExisting([webElement(app, label: "Sign out"), webText(app, "Sign out")], timeout: 10)
        sleep(1)
        screenshot("1-account-menu")
        attachText("1-account-menu-labels", webLabels(app).joined(separator: "\n"))
        guard let signOut = signOut else {
            XCTFail("the Account menu has no Sign out")
            return
        }
        signOut.tap()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20),
                      "Sign out did not bring back the native sign-in; state \(debugState(app))")
        XCTAssertTrue(tab(app, .home).waitForNonExistence(timeout: 5), "the tab bar stayed after Sign out")
        sleep(1)
        screenshot("2-after-sign-out")
        sleep(3)
        app.terminate()

        // The cookie is gone: a relaunch starts on the sign-in screen and stays there.
        app = launch(base: ShellTestCase.mockA, moment: "relaunch", reset: false, auto: true)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 10))
        sleep(3)
        XCTAssertFalse(tab(app, .home).exists, "the relaunch after Sign out went to the tabs")

        // And back in through the sheet.
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "signing in again did not reach the tabs")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        sleep(1)
        screenshot("3-signed-in-again")
    }

    // e.
    func testFallbackToWebSignIn() throws {
        let app = launch(base: ShellTestCase.mockB, moment: "no-handoff")
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        let cancel = app.buttons["web-sign-in-cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), "no web sign-in fallback")
        let safariViewService = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        XCTAssertNotEqual(safariViewService.state, .runningForeground, "a sign-in sheet opened on a server without the hand-off")
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20), "no web view in the fallback")
        let hasContent = firstExisting([web.buttons.firstMatch, web.textFields.firstMatch, web.links.firstMatch], timeout: 25) != nil
        sleep(2)
        screenshot("web-sign-in")
        attachText("web-sign-in-labels", webLabels(app).joined(separator: "\n"))
        XCTAssertTrue(hasContent, "the web sign-in page showed nothing to use")
        XCTAssertFalse(tab(app, .home).exists, "the tab bar shows during the web sign-in")
        cancel.tap()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 10), "Cancel did not return to the native sign-in")
        XCTAssertFalse(app.webViews.firstMatch.exists, "the web view is still visible after Cancel")
        screenshot("after-cancel")
    }

    // f.
    func testOfflineLock() throws {
        var app = launch(base: ShellTestCase.mockA, moment: "forced",
                         extra: ["OPENBOT_SHELL_FORCE_OFFLINE": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15), "no offline lock")
        assertLockScreen(app, reason: "no-network")
        let button = app.buttons["sign-in-button"]
        XCTAssertFalse(button.exists && button.isHittable, "the Sign in button is reachable under the lock")
        // Tap where the Sign in button sits: nothing may start.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        sleep(2)
        XCTAssertTrue(debugState(app).contains("signIn=idle"), "a tap under the lock started something: \(debugState(app))")
        XCTAssertTrue(lockScreen(app).exists, "the lock went away")
        screenshot("offline-lock")
        app.terminate()
        app = launch(base: ShellTestCase.mockA, moment: "forced-dark",
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE": "1", "OPENBOT_SHELL_FORCE_DARK": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15))
        sleep(1)
        screenshot("offline-lock-dark")
        app.terminate()

        // Offline for 6 s, then the real network: the lock lifts and the sign-in screen is back.
        app = launch(base: ShellTestCase.mockA, moment: "timed",
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE_SECONDS": "6"])
        XCTAssertTrue(app.descendants(matching: .any)["offline-lock"].waitForExistence(timeout: 5), "no lock in the first seconds")
        screenshot("offline-lock-timed")
        XCTAssertTrue(app.descendants(matching: .any)["offline-lock"].waitForNonExistence(timeout: 20), "the lock did not lift")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sign-in-button"].isHittable)
        screenshot("after-offline-lifted")
        app.terminate()

        // Signed in, offline at launch for 6 s: the tabs and Home come back by themselves.
        app = launchSignedIn(moment: "sign-in")
        sleep(4)
        app.terminate()
        app = launch(base: ShellTestCase.mockA, moment: "signed-in-timed", reset: false,
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE_SECONDS": "6"])
        XCTAssertTrue(app.descendants(matching: .any)["offline-lock"].waitForExistence(timeout: 5))
        screenshot("signed-in-offline-lock")
        XCTAssertTrue(app.descendants(matching: .any)["offline-lock"].waitForNonExistence(timeout: 20))
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 10))
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 20))
        screenshot("signed-in-after-offline-lifted")
    }

    // g.
    func testKeyboardHidesTabBar() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        let composer = firstExisting([app.webViews.textViews.firstMatch, app.webViews.textFields.firstMatch], timeout: 15)
        guard let composer = composer else {
            screenshot("no-composer")
            attachText("home-labels", webLabels(app).joined(separator: "\n"))
            XCTFail("no composer on Home")
            return
        }
        composer.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 8) else {
            screenshot("no-software-keyboard")
            note("the software keyboard did not show under XCUITest; state \(debugState(app))")
            throw XCTSkip("the simulator's software keyboard did not show under XCUITest")
        }
        XCTAssertTrue(tab(app, .home).waitForNonExistence(timeout: 5), "the tab bar stayed up with the keyboard")
        sleep(1)
        screenshot("keyboard-up")
        note("keyboard up: \(debugState(app))")

        webText(app, "Start a conversation").tap()
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 5) {
            app.webViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "the keyboard did not go away")
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 5), "the tab bar did not come back")
        sleep(1)
        screenshot("keyboard-dismissed")
    }

    // E. Back from the background: the page is alive and the tabs still route.
    func testResumeFromBackground() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        XCUIDevice.shared.press(.home)
        sleep(40)
        app.activate()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 10), "no tabs after coming back")
        sleep(2)
        screenshot("1-back-from-background")
        XCTAssertTrue(webText(app, "Start a conversation").exists, "Home is not on screen after coming back")
        tab(app, .conversations).tap()
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 15), "the tabs stopped routing after coming back")
        sleep(1)
        screenshot("2-conversations-after-background")
        note("after background: \(debugState(app))")
    }

    // MARK: - Helpers

    private func accountButton(_ app: XCUIApplication) -> XCUIElement {
        webElement(app, label: "Account")
    }

    private func checkTabBar(_ app: XCUIApplication) {
        let conversations = tab(app, .conversations)
        let home = tab(app, .home)
        let bots = tab(app, .bots)
        XCTAssertTrue(conversations.exists && home.exists && bots.exists, "the tab bar does not have its three tabs")
        guard conversations.exists, home.exists, bots.exists else { return }
        XCTAssertLessThan(conversations.frame.minX, home.frame.minX, "Conversations is not left of Home")
        XCTAssertLessThan(home.frame.minX, bots.frame.minX, "Home is not left of Bots")
        let web = app.webViews.firstMatch
        let bar = app.tabBars.firstMatch
        if web.exists, bar.exists {
            // The web view ends where the tab bar starts.
            XCTAssertLessThanOrEqual(web.frame.maxY, bar.frame.minY + 1, "the web view runs under the tab bar")
            XCTAssertLessThanOrEqual(web.frame.maxY, home.frame.minY + 1, "the web view runs under the tab buttons")
            note("web view frame \(web.frame), tab bar \(bar.frame), home tab \(home.frame), window \(app.windows.firstMatch.frame)")
        }
    }
}
