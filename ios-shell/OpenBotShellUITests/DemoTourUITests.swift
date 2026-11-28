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
        let app = launch(base: ShellTestCase.mockA, moment: "tour", ephemeral: false)
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
        if firstExisting(links, timeout: 40) != nil {
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
        // Sent from Home, the conversation belongs to Home's stack: Home stays highlighted, and
        // Back returns to Home.
        XCTAssertTrue(tab(app, .home).isSelected, "demo: sending from Home moved the tab")
        tapWhenThere(webElement(app, label: "Back"), "Back in the conversation sent from Home")
        _ = composer.waitForExistence(timeout: 10)
        pause(1)
        scene("send")

        // Chats: the sidebar's own list (unread and Working rows); open one, then Back.
        tab(app, .conversations).tap()
        let chatRow = { (title: String) in app.webViews.links.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch }
        XCTAssertTrue(chatRow("Competitor pricing notes").waitForExistence(timeout: 15), "demo: no Chats list")
        pause(2)
        tapWhenThere(chatRow("Launch announcement"), "an unread conversation")
        tapWhenThere(webElement(app, label: "Back"), "Back in the conversation", timeout: 15)
        pause(1.2)
        // Leave one open in Chats, for later.
        tapWhenThere(chatRow("Quarterly forecast"), "Quarterly forecast")
        _ = webElement(app, label: "Back").waitForExistence(timeout: 15)
        dismissKeyboardIfUp(app)
        pause(1)
        scene("chats")

        // Bots: each Bot as a group with its conversations; open one, then swipe back from the edge.
        tab(app, .bots).tap()
        tapWhenThere(chatRow("Hiring plan"), "a conversation under a Bot", timeout: 15)
        _ = webElement(app, label: "Back").waitForExistence(timeout: 15)
        dismissKeyboardIfUp(app)
        XCTAssertTrue(tab(app, .bots).isSelected, "demo: a conversation from Bots moved the tab")
        pause(1.2)
        // Slowly, so the recording shows the page sliding over the Bots list.
        note("video-swipe start \(Date().timeIntervalSince1970)")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.45))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.47)),
                   withVelocity: .slow, thenHoldForDuration: 0)
        note("video-swipe end \(Date().timeIntervalSince1970)")
        XCTAssertTrue(app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Search Bots'")).firstMatch
            .waitForExistence(timeout: 10), "demo: the edge swipe did not return to the Bots list")
        pause(1.2)
        scene("bots")

        // Back to Chats: the conversation is where it was left. Chats again: its list.
        tab(app, .conversations).tap()
        _ = firstExisting([webText(app, "Here is the first draft."), webText(app, "Can you draft the quarterly forecast?")], timeout: 10)
        dismissKeyboardIfUp(app)
        pause(1.5)
        tab(app, .conversations).tap()
        _ = chatRow("Competitor pricing notes").waitForExistence(timeout: 10)
        pause(1.2)
        scene("where-it-was-left")

        // Sign out from the web app's own Account menu: the native sign-in screen.
        tapWhenThere(webElement(app, label: "Account"), "Account button")
        pause(1.2)
        tapWhenThere(webElement(app, label: "Sign out"), "Sign out", timeout: 5)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20), "demo: Sign out did not return")
        pause(1.5)
        scene("sign-out")
    }

}
