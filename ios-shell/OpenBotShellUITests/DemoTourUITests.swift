import XCTest

/// A paced tour of the app against mock stack A, for the screen recording CI makes of it
/// (`-only-testing:OpenBotShellUITests/DemoTourUITests/testDemoTour`). Not part of the main suite.
final class DemoTourUITests: ShellTestCase {
    private func pause(_ seconds: Double = 1.2) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func tapWhenThere(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 20) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("demo: no \(what)")
            return
        }
        element.tap()
    }

    /// Swipes in from the left edge: the web view's back gesture.
    private func edgeSwipeBack(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func testDemoTour() throws {
        note("video-mark start \(Date().timeIntervalSince1970)")
        defer { note("video-mark end \(Date().timeIntervalSince1970)") }
        var app = launch(base: ShellTestCase.mockA, moment: "tour")
        let signIn = app.buttons["sign-in-button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20))
        pause(2)
        signIn.tap()

        // The system sheet with the mock's page, followed by hand.
        let link = app.webViews.links["Sign in as test person"]
        if link.waitForExistence(timeout: 20) {
            pause(1.5)
            link.tap()
        } else {
            XCTFail("demo: the sheet's link was not reachable")
        }
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 45), "demo: no tabs after signing in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        pause(2)

        // The software keyboard: the tab bar hides, the message box sits on the keyboard.
        if let box = firstExisting([app.webViews.textViews.firstMatch, app.webViews.textFields.firstMatch], timeout: 10) {
            box.tap()
            if app.keyboards.firstMatch.waitForExistence(timeout: 8) {
                pause(1)
                box.typeText("What changed in competitor pricing?")
                pause(1.5)
                webText(app, "Start a conversation").tap()
                if !app.keyboards.firstMatch.waitForNonExistence(timeout: 4) {
                    app.webViews.firstMatch.swipeDown()
                }
            } else {
                note("demo: the software keyboard did not show")
            }
        }
        pause(1.5)

        // Conversations: scroll, open one, swipe back.
        tapWhenThere(tab(app, .conversations), "Conversations tab")
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 20))
        pause(1.2)
        app.webViews.firstMatch.swipeUp()
        pause(0.8)
        app.webViews.firstMatch.swipeDown()
        pause(1)
        webText(app, "Competitor pricing notes").tap()
        let transcript = firstExisting([webText(app, "All three moved to per-seat pricing this year."),
                                        webText(app, "What do our three closest competitors charge?")], timeout: 20)
        pause(2)
        // The conversation focuses its message box: put the keyboard away to see the tab bar again.
        dismissKeyboardIfUp(app, tapping: transcript)
        pause(1.2)
        edgeSwipeBack(app)
        if !webText(app, "Quarterly forecast").waitForExistence(timeout: 6) {
            note("demo: the edge swipe did not go back; using the tab")
            tab(app, .conversations).tap()
        }
        pause(1.5)

        // Bots: open one.
        tapWhenThere(tab(app, .bots), "Bots tab")
        tapWhenThere(webText(app, "Research Bot"), "Research Bot")
        pause(2)
        dismissKeyboardIfUp(app)

        // Home, the Account menu, Settings and back.
        tapWhenThere(tab(app, .home), "Home tab")
        pause(1.2)
        tapWhenThere(webElement(app, label: "Account"), "Account button")
        pause(1.2)
        tapWhenThere(webElement(app, label: "Settings"), "Settings item")
        pause(2.5)
        tapWhenThere(tab(app, .home), "Home tab")
        _ = webText(app, "Start a conversation").waitForExistence(timeout: 10)
        pause(1.5)

        // Sign out from the Account menu: the native sign-in screen.
        tapWhenThere(webElement(app, label: "Account"), "Account button", timeout: 10)
        pause(1.2)
        tapWhenThere(webElement(app, label: "Sign out"), "Sign out item")
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20), "demo: Sign out did not return")
        pause(2)
        app.terminate()

        // The lock screen, then the connection comes back.
        app = launch(base: ShellTestCase.mockA, moment: "tour-offline", reset: false,
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE_SECONDS": "4"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 5))
        XCTAssertTrue(lockScreen(app).waitForNonExistence(timeout: 15), "demo: the lock did not lift")
        pause(2)
    }
}
