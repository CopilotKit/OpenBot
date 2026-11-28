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
        let links = [app.webViews.links["Sign in as test person"], app.links["Sign in as test person"],
                     service.webViews.links["Sign in as test person"], service.links["Sign in as test person"]]
        if let first = firstExisting([consent] + links, timeout: 20), first == consent {
            pause(1.2)
            consent.tap()
        } else {
            note("demo: no consent alert this time")
        }
        if let link = firstExisting(links, timeout: 20) {
            pause(1.2)
            link.tap()
        } else {
            XCTFail("demo: the sheet's link was not reachable")
        }
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "demo: no tabs after signing in")
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        pause(1.2)
        scene("sign-in")

        // The software keyboard: the tab bar hides, the message box and Send sit on it. Send, the
        // reply (mock stack A runs with MOCK_REPLY=1), then a drag down puts the keyboard away.
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        if keyboard.waitForExistence(timeout: 6) {
            composer.typeText("What changed in competitor pricing?")
            let send = webElement(app, label: "Send message")
            if send.waitForExistence(timeout: 5) {
                XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1, "demo: Send is under the keyboard")
                pause(1)
                send.tap()
            } else {
                XCTFail("demo: no Send button")
            }
            let reply = webText(app, "Two of the three cut their entry price")
            XCTAssertTrue(reply.waitForExistence(timeout: 15), "demo: no reply")
            pause(1.5)
            if keyboard.exists {
                app.webViews.firstMatch.swipeDown()
                note(keyboard.waitForNonExistence(timeout: 2)
                     ? "demo: the drag down put the keyboard away"
                     : "demo: the drag down left the keyboard up")
            }
            dismissKeyboardIfUp(app)
            pause(1)
        } else {
            XCTFail("demo: no keyboard")
        }
        scene("send")

        // Conversations, one conversation.
        tab(app, .conversations).tap()
        let row = webText(app, "Competitor pricing notes")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        pause(1)
        row.tap()
        let answer = webText(app, "All three moved to per-seat pricing this year.")
        _ = answer.waitForExistence(timeout: 15)
        pause(1.2)
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
