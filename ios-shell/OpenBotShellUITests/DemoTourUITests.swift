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
        let recording = ProcessInfo.processInfo.environment["OPENBOT_SHELL_RECORDING_SIGNAL"]
        if let recording {
            try Data().write(to: URL(fileURLWithPath: recording + ".ready"), options: .atomic)
            let started = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                FileManager.default.fileExists(atPath: recording + ".started")
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [started], timeout: 30), .completed,
                           "the simulator recorder did not start")
        }
        note("video-mark start \(Date().timeIntervalSince1970)")
        defer {
            note("video-mark end \(Date().timeIntervalSince1970)")
            if let recording { FileManager.default.createFile(atPath: recording + ".done", contents: nil) }
        }
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
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            link.exists && link.isHittable
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, "demo: confirmation was not tappable")
        pause(1.2)
        link.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(tab(app, .home).waitForExistence(timeout: 30), "demo: no tabs after signing in")
        let composer = app.webViews.textViews["Message"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        let skeleton = app.descendants(matching: .any)["loading-skeleton"]
        XCTAssertTrue(skeleton.waitForNonExistence(timeout: 20), "demo: the Home loading screen stayed visible")
        pause(1.2)
        scene("sign-in")

        // The software keyboard: the tab bar hides, the message box sits on it.
        focusComposerForTyping(composer, in: app)
        let keyboard = app.keyboards.firstMatch
        composer.typeText("Competitor pricing?")
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
            // Send navigates from Home to a freshly mounted conversation editor. The reply can
            // already be visible while the editor is still disabled during the stream.
            let editor = app.webViews.textViews["Message"].firstMatch
            let editable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                editor.exists && editor.isEnabled && editor.isHittable
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [editable], timeout: 20), .completed,
                           "demo: the conversation editor did not become available")
            // Tap the first line of the empty editable region on a tall message box.
            editor.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.25)).tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 12), "demo: the conversation keyboard did not open")
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

        // End on the lock screen. The connectivity suite exercises live recovery.
        app = launch(base: ShellTestCase.mockA, moment: "tour-offline", reset: false,
                     extra: ["OPENBOT_SHELL_FORCE_OFFLINE": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 25), "demo: no lock screen")
        assertLockScreen(app, reason: "no-network")
        pause(3)
        scene("lock")
    }
}
