import XCTest

/// A paced tour of the app against mock stack A, for the screen recording the video workflow makes
/// of it (`-only-testing:OpenBotShellUITests/DemoTourUITests/testDemoTour`). Each scene waits for
/// the next thing to appear rather than sleeping, and pauses only where a person needs to read.
final class DemoTourUITests: ShellTestCase {
    private var sceneStart = Date()

    private func pause(_ seconds: Double = 1.0) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Notes how long the last scene took, to see where a recording spends its time.
    private func scene(_ name: String) {
        note(String(format: "scene %@ took %.1f s", name, Date().timeIntervalSince(sceneStart)))
        sceneStart = Date()
    }

    private func tapWhenThere(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 15) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("demo: no \(what)")
            return
        }
        element.tap()
    }

    func testDemoTour() throws {
        continueAfterFailure = false
        note("video-mark start \(Date().timeIntervalSince1970)")
        defer { note("video-mark end \(Date().timeIntervalSince1970)") }
        sceneStart = Date()

        // Sign in, not ephemeral: the system's consent alert, as a person sees it.
        var app = launch(base: ShellTestCase.mockA, moment: "tour", ephemeral: false)
        let signIn = app.buttons["sign-in-button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20))
        pause(1)
        signIn.tap()
        // Whichever comes first: the consent alert (then the sheet), or the sheet.
        let consent = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Continue"]
        let service = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let links = [service.links["Sign in as test person"], app.links["Sign in as test person"]]
        // A cold Safari sheet can take longer than 20 s to render its first localhost page.
        guard let first = firstExisting([consent] + links, timeout: 60) else {
            screenshot("sign-in-sheet-unavailable")
            XCTFail("demo: neither consent nor the sheet’s sign-in link appeared")
            return
        }
        let link: XCUIElement
        if first == consent {
            pause(1.5)
            consent.tap()
            guard let loaded = firstExisting(links, timeout: 60) else {
                screenshot("sign-in-sheet-unavailable")
                XCTFail("demo: the sheet’s sign-in link did not load after consent")
                return
            }
            link = loaded
        } else {
            link = first
        }
        pause(1.2)
        link.tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "demo: no tabs after signing in")
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        pause(1.2)
        scene("sign-in")

        // The software keyboard: the tab bar hides, the message box sits on it.
        focusComposerForTyping(composer, in: app)
        let keyboard = app.keyboards.firstMatch
        composer.typeText("What changed in competitor pricing?")
        let send = webElement(app, label: "Send message")
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1)
        XCTAssertTrue(send.isHittable)
        screenshot("home-keyboard-send")
        pause(1)
        send.tap()
        let reply = webText(app, "All three competitors now charge per seat.")
        XCTAssertTrue(reply.waitForExistence(timeout: 20), "demo: the reply did not appear")
        screenshot("conversation-reply")
        pause(1.5)
        if !keyboard.exists {
            composer.tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 8))
        }
        app.webViews.firstMatch.swipeDown()
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "demo: dragging down did not dismiss the keyboard")
        scene("keyboard")

        // Conversations, one conversation.
        tab(app, .conversations).tap()
        let row = webText(app, "Competitor pricing notes")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        pause(1)
        row.tap()
        let answer = webText(app, "All three moved to per-seat pricing this year.")
        XCTAssertTrue(answer.waitForExistence(timeout: 15))
        pause(1.5)
        dismissKeyboardIfUp(app, tapping: answer)
        scene("conversation")

        // Bots, one Bot.
        tab(app, .bots).tap()
        tapWhenThere(webText(app, "Research Bot"), "Research Bot")
        pause(1.5)
        dismissKeyboardIfUp(app)
        scene("bots")

        // Home, then Sign out from the web app's own Account menu: the native sign-in screen.
        tab(app, .home).tap()
        _ = composer.waitForExistence(timeout: 10)
        tapWhenThere(webElement(app, label: "Account"), "Account button")
        pause(1.2)
        tapWhenThere(webElement(app, label: "Sign out"), "Sign out", timeout: 5)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20), "demo: Sign out did not return")
        pause(1.5)
        app.terminate()
        scene("sign-out")

        // The lock screen, then the connection comes back.
        app = launch(base: ShellTestCase.mockA, moment: "tour-offline", reset: false,
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE_SECONDS": "4"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 8), "demo: no lock screen")
        XCTAssertTrue(lockScreen(app).waitForNonExistence(timeout: 15), "demo: the lock did not lift")
        pause(1.5)
        scene("lock")
    }
}
