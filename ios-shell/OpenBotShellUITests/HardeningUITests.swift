import XCTest

/// The edges a person meets without trying: the largest text size, dark mode, VoiceOver, turning the
/// device, iOS killing the page's process, a server that takes the connection and never answers.
/// Against mock stack A (and, for the last one, a silent server the workflow starts on 3013). On an
/// iPad simulator (the workflow's `device: ipad`) the same tests check the iPad's layout.
final class HardeningUITests: ShellTestCase {
    static let silent = "http://127.0.0.1:3013"
    static let largestText = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    /// The native screens at the largest accessibility text size: every control on screen and
    /// tappable (scrolling to it if the screen scrolls), in light and in dark.
    func testLargestDynamicType() throws {
        for dark in [false, true] {
            let mode = dark ? "dark" : "light"
            var extra: [String: String] = dark ? ["OPENBOT_SHELL_FORCE_DARK": "1"] : [:]
            var app = launch(base: ShellTestCase.mockA, moment: "first-\(mode)", extra: extra, arguments: Self.largestText)
            let signIn = app.buttons["sign-in-button"]
            XCTAssertTrue(signIn.waitForExistence(timeout: 20), "no Sign in at the largest text size (\(mode))")
            if !signIn.isHittable { app.swipeUp() }
            XCTAssertTrue(signIn.isHittable, "Sign in cannot be tapped at the largest text size (\(mode))")
            sleep(1)
            screenshot("first-screen-largest-text-\(mode)")
            app.terminate()

            extra["OPENBOT_SHELL_FORCE_OFFLINE"] = "1"
            app = launch(base: ShellTestCase.mockA, moment: "lock-\(mode)", extra: extra, arguments: Self.largestText)
            XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15), "no lock screen (\(mode))")
            sleep(1)
            screenshot("lock-largest-text-\(mode)")
            let retry = app.buttons["retry-button"]
            for _ in 0..<4 where !retry.isHittable { app.swipeUp() }
            XCTAssertTrue(retry.isHittable, "Try again cannot be reached at the largest text size (\(mode))")
            XCTAssertTrue(app.buttons["support-email"].exists, "no support link at the largest text size (\(mode))")
            screenshot("lock-largest-text-scrolled-\(mode)")
            app.terminate()
        }

        let app = launchSignedIn(arguments: Self.largestText)
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        for tab in [Tab.conversations, .home, .bots] {
            XCTAssertTrue(self.tab(app, tab).isHittable, "the \(tab) tab cannot be tapped at the largest text size")
        }
        sleep(1)
        screenshot("tab-bar-largest-text")
        tab(app, .bots).tap()
        XCTAssertTrue(webText(app, "Research Bot").waitForExistence(timeout: 15), "the tabs do not route at the largest text size")
    }

    /// Every native screen in dark: the first screen, the sign-in in progress, the skeleton, the tab
    /// bar over a page, and both kinds of lock screen.
    func testNativeScreensInDark() throws {
        let dark = ["OPENBOT_SHELL_FORCE_DARK": "1"]
        var app = launch(base: ShellTestCase.mockA, moment: "first", extra: dark)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20))
        sleep(1)
        screenshot("1-first-screen-dark")
        app.terminate()

        app = launchSignedIn(moment: "sign-in", extra: dark)
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        sleep(1)
        screenshot("2-home-and-tab-bar-dark")
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.terminate()

        var extra = dark
        extra["OPENBOT_SHELL_DELAY_FIRST_LOAD_SECONDS"] = "3"
        app = launch(base: ShellTestCase.mockA, moment: "skeleton", reset: false, extra: extra)
        XCTAssertTrue(app.descendants(matching: .any)["loading-skeleton"].waitForExistence(timeout: 10))
        screenshot("3-skeleton-dark")
        app.terminate()

        extra = dark
        extra["OPENBOT_SHELL_FORCE_OFFLINE"] = "1"
        app = launch(base: ShellTestCase.mockA, moment: "no-network", reset: false, extra: extra)
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15))
        sleep(1)
        screenshot("4-lock-no-network-dark")
        app.terminate()

        app = launch(base: "http://127.0.0.1:3999", moment: "unreachable", extra: dark)
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 20))
        app.buttons["sign-in-button"].tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 30), "no lock screen for a server that is not there")
        sleep(1)
        screenshot("5-lock-load-failed-dark")
    }

    /// What VoiceOver reads for the native controls.
    func testVoiceOverLabels() throws {
        var app = launch(base: ShellTestCase.mockA, moment: "first")
        let signIn = app.buttons["sign-in-button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20))
        XCTAssertEqual(signIn.label, "Sign in")
        XCTAssertTrue(app.staticTexts["OpenBot"].exists, "the first screen's heading is not readable")
        app.terminate()

        app = launch(base: ShellTestCase.mockA, moment: "lock", extra: ["OPENBOT_SHELL_FORCE_OFFLINE": "1"])
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons["retry-button"].label, "Try again")
        XCTAssertEqual(app.buttons["support-email"].label, "Email support at support@open.bot")
        XCTAssertEqual(app.staticTexts["offline-lock-heading"].label, ShellTestCase.lockHeading)
        app.terminate()

        app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        let expected: [(Tab, String)] = [(.conversations, "Conversations"), (.home, "Home"), (.bots, "Bots")]
        for (tab, label) in expected {
            XCTAssertEqual(self.tab(app, tab).label, label, "the \(tab) tab's label")
        }
        XCTAssertTrue(tab(app, .home).isSelected, "Home is not read as the selected tab")
        attachText("tab-bar-labels", labels(in: app.tabBars.firstMatch).joined(separator: "\n"))
    }

    /// A phone stays in portrait. An iPad turns, and the tab bar and the page follow.
    func testRotation() throws {
        let app = launchSignedIn()
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        let window = app.windows.firstMatch.frame
        let bar = app.tabBars.firstMatch
        let web = app.webViews.firstMatch
        note("landscape: window \(window), tab bar \(bar.frame), web view \(web.frame)")
        screenshot(isPad ? "ipad-landscape" : "phone-turned-to-landscape")
        if isPad {
            XCTAssertGreaterThan(window.width, window.height, "the iPad did not turn")
            XCTAssertEqual(bar.frame.width, window.width, accuracy: 1, "the tab bar does not span the turned iPad")
            XCTAssertEqual(web.frame.maxY, bar.frame.minY, accuracy: 1.5, "the web view does not end at the tab bar")
            XCTAssertEqual(web.frame.width, window.width, accuracy: 1, "the web view does not fill the turned iPad")
        } else {
            XCTAssertLessThan(window.width, window.height, "the phone app turned to landscape")
        }
        tab(app, .conversations).tap()
        XCTAssertTrue(webText(app, "Competitor pricing notes").waitForExistence(timeout: 15), "the tabs stopped routing after turning")
        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        screenshot("back-to-portrait")
        XCTAssertEqual(web.frame.maxY, bar.frame.minY, accuracy: 1.5, "the web view does not end at the tab bar after turning back")
    }

    /// iOS kills the web content process (memory pressure, a crash): the skeleton covers the page
    /// while it reloads, never a blank web view, and Home comes back.
    func testWebContentProcessKilledRecovers() throws {
        var app = launchSignedIn(moment: "sign-in")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.terminate()
        app = launch(base: ShellTestCase.mockA, moment: "killed", reset: false,
                     extra: ["OPENBOT_SHELL_TEST_KILL_CONTENT_SECONDS": "6"])
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 30))
        let skeleton = app.descendants(matching: .any)["loading-skeleton"]
        XCTAssertTrue(waitForState(app, "restarts=1", timeout: 15), "the web content process was not restarted: \(debugState(app))")
        // The skeleton may be up for well under a second on the mock: the counter proves it went up.
        if skeleton.exists { screenshot("skeleton-after-kill") }
        let after = stateValue(app, "skeletons").flatMap(Int.init) ?? 0
        note("after the kill: skeletons shown \(after); state \(debugState(app))")
        // One for the launch, one for the reload after the kill.
        XCTAssertGreaterThanOrEqual(after, 2, "the skeleton did not cover the page while it reloaded after the kill")
        XCTAssertTrue(skeleton.waitForNonExistence(timeout: 20), "the skeleton stayed after the reload")
        XCTAssertTrue(webText(app, "Start a conversation").waitForExistence(timeout: 20), "Home did not come back after the kill")
        XCTAssertTrue(tab(app, .home).exists, "no tabs after the kill")
        sleep(1)
        screenshot("home-after-kill")
        tab(app, .bots).tap()
        XCTAssertTrue(webText(app, "Research Bot").waitForExistence(timeout: 15), "the tabs stopped routing after the kill")
    }

    /// A server that takes the connection and never answers: the skeleton covers the wait and the
    /// lock screen replaces it at the load deadline (WebController.watchdogSeconds). At every moment
    /// one of the two is on screen: no blank web view in between.
    func testSlowServerShowsSkeletonThenLock() throws {
        let app = launch(base: Self.silent, moment: "silent",
                         extra: ["OPENBOT_SHELL_TEST_PLAIN_SESSION_COOKIE": "mock"])
        let skeleton = app.descendants(matching: .any)["loading-skeleton"]
        XCTAssertTrue(skeleton.waitForExistence(timeout: 10), "no skeleton while the server is silent")
        screenshot("1-skeleton-while-silent")
        let start = Date()
        var gap: TimeInterval?
        var locked = false
        while Date().timeIntervalSince(start) < 35 {
            if lockScreen(app).exists { locked = true; break }
            if !skeleton.exists && gap == nil { gap = Date().timeIntervalSince(start) }
            Thread.sleep(forTimeInterval: 0.5)
        }
        let waited = Date().timeIntervalSince(start)
        note(String(format: "silent server: lock after %.1f s; skeleton gone before the lock at %@", waited,
                    gap.map { String(format: "%.1f s", $0) } ?? "never"))
        XCTAssertTrue(locked, "no lock screen within 35 s of a silent server")
        XCTAssertNil(gap, "neither the skeleton nor the lock screen was on screen for a moment")
        if locked {
            sleep(1)
            screenshot("2-lock-after-deadline")
            assertLockScreen(app, reason: "load-failed")
        }
    }
}
