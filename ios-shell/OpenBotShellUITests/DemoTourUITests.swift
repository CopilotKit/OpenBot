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

    /// Run before the recording, unrecorded: the first launch on a fresh simulator (WebKit's caches,
    /// the sheet's Safari service, the mock's first answers) took over a minute to sign in.
    func testWarmUp() throws {
        let app = launchSignedIn(moment: "warm-up")
        _ = webText(app, "Start a conversation").waitForExistence(timeout: 60)
        let composer = app.webViews.textViews.firstMatch
        if composer.waitForExistence(timeout: 10), focusComposer(app, composer) {
            composer.typeText("hi")
            dragPageDown(app)
        }
        tab(app, .conversations).tap()
        _ = webText(app, "Competitor pricing notes").waitForExistence(timeout: 20)
        app.terminate()
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
        if firstExisting(links, timeout: 20) != nil {
            pause(1.2)
            // Found again just before the tap: the sheet's page can redraw it in the meantime.
            if let link = firstExisting(links, timeout: 5) { link.tap() } else { XCTFail("demo: the sheet's link went away") }
        } else {
            XCTFail("demo: the sheet's link was not reachable")
        }
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "demo: no tabs after signing in")
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        pause(1.2)
        scene("sign-in")

        // Home: the software keyboard comes up, the tab bar hides, the message box and Send sit on it.
        // Send: the new conversation opens with the message, the reply comes in (mock stack A runs
        // with MOCK_REPLY=1 and keeps the conversations it creates), and a drag down to the keyboard
        // puts it away.
        let keyboard = app.keyboards.firstMatch
        if focusComposer(app, composer) {
            composer.typeText("What changed in competitor pricing?")
            let send = webElement(app, label: "Send message")
            if send.waitForExistence(timeout: 5) {
                XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1, "demo: Send is under the keyboard")
                pause(0.8)
                send.tap()
            } else {
                XCTFail("demo: no Send button")
            }
            let reply = webText(app, "Two of the three cut their entry price")
            XCTAssertTrue(reply.waitForExistence(timeout: 15), "demo: no reply")
            pause(1.5)
            if keyboard.exists {
                dragPageDown(app)
                note(keyboard.waitForNonExistence(timeout: 2) ? "demo: the drag down put the keyboard away"
                                                              : "demo: the drag down left the keyboard up")
            }
            dismissKeyboardIfUp(app)
            pause(1)
        } else {
            XCTFail("demo: no keyboard on Home")
        }
        scene("send")

        // Conversations: the new one is in the list.
        tab(app, .conversations).tap()
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 15), "demo: no conversation list")
        pause(1.5)
        scene("conversations")

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
