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
        leaveAndTerminate(app)
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
        leaveAndTerminate(app)
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
        // Every sign-in clears the site's data before `enter` too: count from here.
        let clearedBefore = Int(stateValue(app, "cleared") ?? "0") ?? 0
        signOut.tap()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20),
                      "Sign out did not bring back the native sign-in; state \(debugState(app))")
        XCTAssertTrue(tab(app, .home).waitForNonExistence(timeout: 5), "the tab bar stayed after Sign out")
        // Review item H: the site's data went with the session, so the next person starts clean.
        XCTAssertTrue(waitForState(app, "cleared=\(clearedBefore + 1)", timeout: 10), "sign-out did not clear the site's data: \(debugState(app))")
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
        // To the background first, as a person leaves an app: WebKit writes cookies to disk
        // lazily, and a kill seconds after signing in can lose the new session cookie.
        XCUIDevice.shared.press(.home)
        sleep(3)
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

        // No form-assistant bar (its check mark was a way to close the keyboard): drag the page down.
        let checkMark = app.buttons.matching(NSPredicate(format: "label == 'Done' OR identifier == 'Done'")).firstMatch
        note("keyboard: a Done button above it \(checkMark.exists)")
        app.webViews.firstMatch.swipeDown()
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 4) {
            note("dragging down did not close the keyboard; tapping outside the field")
            webText(app, "Start a conversation").tap()
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

    // Inside the shell the page offers no browser notifications, even where the server has push:
    // not after the first message, and not in Settings, Notifications.
    func testNoBrowserNotificationOffersInTheShell() throws {
        let app = launchSignedIn()
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30))
        XCTAssertTrue(focusComposer(app, composer), "the message box raised no keyboard")
        composer.typeText("Hello there")
        guard let send = firstExisting([webElement(app, label: "Send message")], timeout: 5) else {
            XCTFail("no Send button")
            return
        }
        send.tap()
        sleep(4)
        dismissKeyboardIfUp(app)
        screenshot("1-after-first-message")
        let offer = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] 'Enable notifications'")).firstMatch
        XCTAssertFalse(offer.exists, "the page offers browser notifications inside the shell")
        // Settings, Notifications, through the web app's Account menu.
        tab(app, .home).tap()
        let account = webElement(app, label: "Account")
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.tap()
        guard let settings = firstExisting([webElement(app, label: "Settings")], timeout: 5) else {
            XCTFail("no Settings in the Account menu")
            return
        }
        settings.tap()
        guard let notifications = firstExisting([webText(app, "Notifications")], timeout: 10) else {
            XCTFail("no Notifications row in Settings")
            return
        }
        notifications.tap()
        sleep(3)
        screenshot("2-settings-notifications")
        let row = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] 'Notifications in this browser'")).firstMatch
        XCTAssertFalse(row.exists, "Settings offers notifications in this browser inside the shell")
    }

    // The keyboard: the web view ends at its top edge (the send button stays above it), a drag down
    // dismisses it, the tab bar comes back with the web view right above it, and tabs work after.
    func testKeyboardKeepsTheMessageBoxVisible() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        try checkKeyboardRoundTrip(app, place: "home")

        tab(app, .conversations).tap()
        let row = webText(app, "Quarterly forecast")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(webText(app, "Here is the first draft.").waitForExistence(timeout: 15))
        try checkKeyboardRoundTrip(app, place: "conversation")
        XCTAssertTrue(webText(app, "Here is the first draft.").exists, "the latest message is no longer on screen")

        tab(app, .bots).tap()
        XCTAssertTrue(webText(app, "Research Bot").waitForExistence(timeout: 15), "a tab did not work after dismissing the keyboard")
        screenshot("bots-after-keyboard")
    }

    private func checkKeyboardRoundTrip(_ app: XCUIApplication, place: String) throws {
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "\(place): no message box")
        guard focusComposer(app, composer) else {
            throw XCTSkip("the software keyboard did not show under XCUITest")
        }
        sleep(1)
        let keyboardTop = app.keyboards.firstMatch.frame.minY
        let send = webElement(app, label: "Send message")
        XCTAssertTrue(send.waitForExistence(timeout: 5), "\(place): no Send button")
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboardTop + 1, "\(place): the Send button is under the keyboard")
        XCTAssertGreaterThan(send.frame.minY, 0, "\(place): the Send button is off screen")
        XCTAssertTrue(send.isHittable, "\(place): the Send button cannot be tapped")
        let web = app.webViews.firstMatch
        XCTAssertLessThanOrEqual(web.frame.maxY, keyboardTop + 1, "\(place): the web view runs under the keyboard")
        note("\(place): keyboard top \(keyboardTop), send \(send.frame), web view \(web.frame)")
        screenshot("\(place)-keyboard-up")

        dragPageDown(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "\(place): dragging down did not dismiss the keyboard")
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "\(place): the tab bar did not come back")
        sleep(1)
        XCTAssertEqual(web.frame.maxY, bar.frame.minY, accuracy: 1.5, "\(place): the web view does not end at the tab bar")
        note("\(place): after the drag, web view \(web.frame), tab bar \(bar.frame)")
        screenshot("\(place)-keyboard-dismissed")
    }

    // The native skeleton while the first page loads (the first load is held back 3 s here).
    func testLoadingSkeleton() throws {
        var app = launchSignedIn(moment: "sign-in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        sleep(3)
        leaveAndTerminate(app)
        for (moment, dark) in [("light", false), ("dark", true)] {
            var extra = ["OPENBOT_SHELL_DELAY_FIRST_LOAD_SECONDS": "3"]
            if dark { extra["OPENBOT_SHELL_FORCE_DARK"] = "1" }
            app = launch(base: ShellTestCase.mockA, moment: moment, reset: false, extra: extra)
            let skeleton = app.descendants(matching: .any)["loading-skeleton"]
            XCTAssertTrue(skeleton.waitForExistence(timeout: 10), "no loading skeleton (\(moment))")
            // Review item I: the skeleton takes the taps (a tap at its centre lands on it, not on the
            // page loading under it).
            XCTAssertTrue(skeleton.isHittable, "taps go through the skeleton (\(moment))")
            XCTAssertTrue(tab(app, .home).exists, "the tabs are not usable under the skeleton (\(moment))")
            sleep(1)
            screenshot("skeleton-\(moment)")
            XCTAssertTrue(skeleton.waitForNonExistence(timeout: 20), "the skeleton stayed (\(moment))")
            XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 20))
            screenshot("after-skeleton-\(moment)")
            app.terminate()
        }
    }

    // A page that never says ready (the probe site stands in for a challenge page or an older web
    // app): the skeleton goes by itself, and the lock screen does not come.
    func testSkeletonNeverTrapsAPageWithoutTheBridge() throws {
        let app = launch(base: "http://127.0.0.1:8765", moment: "no-bridge",
                         extra: ["OPENBOT_SHELL_TEST_PLAIN_SESSION_COOKIE": "probe"])
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 15), "no tabs")
        let skeleton = app.descendants(matching: .any)["loading-skeleton"]
        XCTAssertTrue(skeleton.waitForNonExistence(timeout: 15), "the skeleton stayed over a page without the bridge")
        XCTAssertTrue(firstExisting([app.webViews.staticTexts.firstMatch], timeout: 10) != nil, "the page is not shown")
        sleep(25)
        XCTAssertFalse(lockScreen(app).exists, "the load watchdog locked a page that had loaded")
        screenshot("page-without-bridge")
        note("no bridge: \(debugState(app))")
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

    // Review item B: signed in, a swipe back from the left edge never leaves the web app (the history
    // before the sign-in holds the empty launch page and the hand-off). The mock's web sign-in has no
    // way to finish, so the walk back through an identity provider to /sign is not tested here.
    func testBackSwipeStaysOnTheWebApp() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        tab(app, .bots).tap()
        XCTAssertTrue(webText(app, "Research Bot").waitForExistence(timeout: 15))
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
        for step in 1...3 {
            edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
            sleep(2)
            note("after back swipe \(step): \(debugState(app))")
        }
        screenshot("after-back-swipes")
        XCTAssertTrue(tab(app, .home).exists, "a swipe back left the signed-in app: \(debugState(app))")
        XCTAssertEqual(stateValue(app, "phase"), "signedIn", "a swipe back signed the person out")
        let path = stateValue(app, "path") ?? ""
        XCTAssertTrue(path.hasPrefix("/") && !path.hasPrefix("/sign") && !path.hasPrefix("/api"), "a swipe back reached \(path)")
        // Still a page of the web app (an empty launch page would show none of these).
        let page = firstExisting([webText(app, "Research Bot"), webText(app, "Start a conversation"), webText(app, "Bots")], timeout: 5)
        XCTAssertNotNil(page, "after the back swipes the web view shows none of the web app's pages")
        tab(app, .conversations).tap()
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 15), "the tabs stopped routing after the back swipes")
    }

    // Review N1: a live session left in a web view that shows the sign-in screen (WebKit can answer
    // "no cookies" at a cold launch) is cleared, with the site's data, before `enter` loads: the
    // server would refuse another person's ticket. The mock does not tell people apart, so this
    // checks the order (the clear finished, then the sign-in finished), not a refusal.
    func testSignInClearsALeftoverSessionFirst() throws {
        let app = launch(base: ShellTestCase.mockA, moment: "leftover", auto: true,
                         extra: ["OPENBOT_SHELL_TEST_LATE_SESSION_COOKIE": "someone-else"])
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20))
        sleep(2)
        XCTAssertEqual(stateValue(app, "cleared"), "0", "the site's data was cleared before signing in started")
        button.tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "signing in did not reach the tabs: \(debugState(app))")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        let cleared = Int(stateValue(app, "cleared") ?? "0") ?? 0
        note("leftover session: \(debugState(app))")
        XCTAssertGreaterThanOrEqual(cleared, 1, "the leftover session was not cleared before enter")
        XCTAssertEqual(stateValue(app, "phase"), "signedIn")
    }

    // The measurement for the server's Sec-Fetch rule: the headers WebKit sends on the request that
    // loads `enter`, through the very call `enter` uses, (a) from the signed-out first screen and
    // (b) as a renewal does, with a page showing. The probe echoes them into the page.
    func testEnterRequestHeaders() throws {
        let probe = "http://127.0.0.1:8765/api/echo-headers"
        var app = launch(base: ShellTestCase.mockA, moment: "signed-out", auto: true,
                         extra: ["OPENBOT_SHELL_TEST_ENTER_PROBE_URL": probe])
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20))
        app.buttons["sign-in-button"].tap()
        let shellHeader = webText(app, "OpenBot-Shell:")
        XCTAssertTrue(shellHeader.waitForExistence(timeout: 30), "the probe's header page did not load (signed out)")
        let signedOut = webLabels(app).filter { $0.contains("Sec-Fetch") || $0.contains("OpenBot-Shell") }
        note("enter headers, signed out: \(signedOut.joined(separator: "; "))")
        attachText("enter-headers-signed-out", signedOut.joined(separator: "\n"))
        screenshot("enter-headers-signed-out")
        app.terminate()

        // Signed in for real first; the relaunch then makes the renewal's call with Home showing.
        app = launchSignedIn(moment: "sign-in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        leaveAndTerminate(app)
        app = launch(base: ShellTestCase.mockA, moment: "renewal", reset: false,
                     extra: ["OPENBOT_SHELL_TEST_ENTER_PROBE_URL": probe, "OPENBOT_SHELL_TEST_ENTER_PROBE_AFTER_SECONDS": "8"])
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30), "no page showing before the renewal's call")
        XCTAssertTrue(webText(app, "OpenBot-Shell:").waitForExistence(timeout: 40), "the probe's header page did not load (renewal)")
        let renewal = webLabels(app).filter { $0.contains("Sec-Fetch") || $0.contains("OpenBot-Shell") }
        note("enter headers, renewal with a page showing: \(renewal.joined(separator: "; "))")
        attachText("enter-headers-renewal", renewal.joined(separator: "\n"))
        screenshot("enter-headers-renewal")
        XCTAssertTrue(renewal.contains { $0.contains("OpenBot-Shell: ios") }, "the renewal's load did not carry OpenBot-Shell: ios")
        XCTAssertTrue(signedOut.contains { $0.contains("OpenBot-Shell: ios") }, "the sign-in's load did not carry OpenBot-Shell: ios")
    }

    // MARK: - Per-tab navigation (the web app keeps one stack per tab; the shell sends openbot:back)

    private func edgeSwipeBack(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.45))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.47)))
        sleep(2)
    }

    private func chatsList(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Search conversations'")).firstMatch
    }

    private func botsList(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Search Bots'")).firstMatch
    }

    private func openConversation(_ app: XCUIApplication, _ title: String) -> Bool {
        let row = app.webViews.links.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        guard row.waitForExistence(timeout: 15) else { return false }
        row.tap()
        let back = webElement(app, label: "Back")
        let opened = back.waitForExistence(timeout: 15)
        dismissKeyboardIfUp(app)
        return opened
    }

    // A conversation opened from Chats, back by the header's Back and by the edge swipe: the Chats
    // list at the same scroll position, Chats highlighted throughout. At the root the swipe does
    // nothing.
    func testChatsStackBackByControlAndSwipe() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        tapTab(app, .conversations)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 15), "no Chats list")
        app.webViews.firstMatch.swipeUp()
        sleep(1)
        screenshot("1-chats-list-scrolled")
        // A row on screen after the scroll, to measure the scroll by.
        let marker = app.webViews.links.matching(NSPredicate(format: "label CONTAINS 'Trip to Lisbon' OR label CONTAINS 'Launch announcement' OR label CONTAINS 'Board update'")).firstMatch
        let markerY = marker.exists ? marker.frame.minY : -1
        let markerLabel = marker.exists ? marker.label : ""
        note("chats: marker '\(markerLabel.prefix(30))' at \(markerY); \(debugState(app))")

        XCTAssertTrue(openConversation(app, "Quarterly forecast"), "the conversation did not open from Chats")
        XCTAssertTrue(tab(app, .conversations).isSelected, "opening a conversation moved the tab")
        XCTAssertTrue(waitForState(app, "back=page", timeout: 5), "the page did not say it can go back: \(debugState(app))")
        screenshot("2-conversation-from-chats-with-back")
        webElement(app, label: "Back").tap()
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 10), "Back did not return to the Chats list")
        XCTAssertTrue(tab(app, .conversations).isSelected)
        sleep(1)
        screenshot("3-chats-after-back")
        if markerY >= 0 {
            let same = app.webViews.links.matching(NSPredicate(format: "label == %@", markerLabel)).firstMatch
            XCTAssertEqual(same.frame.minY, markerY, accuracy: 8, "the Chats list did not keep its scroll position")
        }

        XCTAssertTrue(openConversation(app, "Quarterly forecast"))
        // A short swipe (a quarter of the width) springs back: the conversation stays.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.45))
            .press(forDuration: 0.3, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.22, dy: 0.46)))
        sleep(2)
        XCTAssertTrue(webElement(app, label: "Back").exists, "a short swipe left the conversation")
        XCTAssertFalse(chatsList(app).exists, "a short swipe went back to the list")
        screenshot("4a-after-short-swipe")
        edgeSwipeBack(app)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 10), "the edge swipe did not return to the Chats list: \(debugState(app))")
        XCTAssertTrue(tab(app, .conversations).isSelected)
        screenshot("4-chats-after-edge-swipe")

        XCTAssertTrue(waitForState(app, "back=none", timeout: 5), "at the root the page should say it cannot go back: \(debugState(app))")
        let commits = stateValue(app, "commits")
        edgeSwipeBack(app)
        XCTAssertTrue(chatsList(app).exists, "an edge swipe at the root left the Chats list")
        XCTAssertEqual(stateValue(app, "commits"), commits, "an edge swipe at the root loaded a page")
        XCTAssertEqual(stateValue(app, "phase"), "signedIn")
    }

    // A conversation opened from the Bots list keeps Bots highlighted; Back returns to the Bots list.
    func testBotsStackKeepsBotsHighlighted() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        tapTab(app, .bots)
        XCTAssertTrue(botsList(app).waitForExistence(timeout: 15), "no Bots list")
        sleep(1)
        screenshot("1-bots-list")
        XCTAssertTrue(openConversation(app, "Hiring plan"), "no conversation opened from the Bots list")
        XCTAssertTrue(tab(app, .bots).isSelected, "a conversation opened from Bots moved the tab")
        screenshot("2-conversation-from-bots")
        webElement(app, label: "Back").tap()
        XCTAssertTrue(botsList(app).waitForExistence(timeout: 10), "Back did not return to the Bots list")
        XCTAssertTrue(tab(app, .bots).isSelected)
        screenshot("3-bots-after-back")
    }

    // Each tab is where it was left: a conversation open in Chats is still open after a visit to
    // Bots; tapping Chats again pops to the list. Settings from the Account menu has Back.
    func testTabsRememberWhereTheyWereLeft() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        tapTab(app, .conversations)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 15))
        XCTAssertTrue(openConversation(app, "Quarterly forecast"))
        tapTab(app, .bots)
        XCTAssertTrue(botsList(app).waitForExistence(timeout: 15))
        tapTab(app, .conversations)
        let transcript = firstExisting([webText(app, "Here is the first draft."), webText(app, "Can you draft the quarterly forecast?")], timeout: 15)
        XCTAssertNotNil(transcript, "the conversation left open in Chats was not there on return")
        // The conversation takes the focus on return: the keyboard hides the tab bar until it goes.
        dismissKeyboardIfUp(app)
        XCTAssertTrue(tab(app, .conversations).waitForExistence(timeout: 5))
        XCTAssertTrue(tab(app, .conversations).isSelected)
        screenshot("1-chats-where-it-was-left")
        tapTab(app, .conversations)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 10), "tapping the current tab did not pop to its list")
        screenshot("2-chats-popped-to-root")

        let account = webElement(app, label: "Account")
        XCTAssertTrue(account.waitForExistence(timeout: 10), "no Account button on Chats")
        account.tap()
        let settings = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Settings'")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "no Settings in the Account menu")
        settings.tap()
        let back = webElement(app, label: "Back")
        XCTAssertTrue(back.waitForExistence(timeout: 10), "Settings has no Back")
        XCTAssertTrue(tab(app, .conversations).isSelected, "Settings moved the tab")
        screenshot("3-settings-with-back")
        back.tap()
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 10), "Back from Settings did not return to Chats")
        screenshot("4-chats-after-settings")
    }

    // The slide back: with the page's will-navigate, a slow swipe from the edge slides the
    // conversation away over the list's picture and lands on the list at its scroll position, with no
    // blank web view on the way (the frames are checked in the video workflow's recording).
    func testSwipeBackSlidesToTheList() throws {
        let app = launchSignedIn(extra: ["OPENBOT_SHELL_SLIDE_BACK": "1"])
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        tapTab(app, .conversations)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 15))
        XCTAssertTrue(openConversation(app, "Quarterly forecast"))
        XCTAssertTrue(waitForState(app, "back=page", timeout: 5), "\(debugState(app))")
        sleep(1)
        // The video workflow's which=swipe recording keeps this part.
        note("video-mark start \(Date().timeIntervalSince1970)")
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.45))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.47)),
                    withVelocity: .slow, thenHoldForDuration: 0)
        XCTAssertTrue(chatsList(app).waitForExistence(timeout: 10), "the slow swipe did not land on the Chats list: \(debugState(app))")
        sleep(2)
        note("video-mark end \(Date().timeIntervalSince1970)")
        XCTAssertTrue(tab(app, .conversations).isSelected)
        sleep(1)
        screenshot("after-slide")
    }
}
