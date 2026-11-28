import XCTest

/// Shared launch, wait and screenshot helpers for the shell's UI tests.
///
/// Servers the tests expect on the Mac that runs the simulator (the CI workflow starts them):
/// - the probe site (ios-shell/Probe/serve.py) on 8765/8766;
/// - mock stack A: the built web app on 3010 over app/workbench/mock-server.ts on 3001, signed out
///   unless the mock's session cookie is sent, with the sign-in hand-off;
/// - mock stack B: the same on 3011 over 3002, without the hand-off (both /api/auth/shell/* 404).
class ShellTestCase: XCTestCase {
    static let mockA = "http://127.0.0.1:3010"
    static let mockB = "http://127.0.0.1:3011"
    static let probe = "http://127.0.0.1:8765/"
    static let production = "https://my.open.bot"

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        XCUIDevice.shared.appearance = .light
    }

    // MARK: - Launching

    /// Launches the app. `base` nil means the app's own default (my.open.bot).
    func launch(base: String?, moment: String, reset: Bool = true, plain: Bool = false,
                ephemeral: Bool = true, auto: Bool = false,
                extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OPENBOT_SHELL_DIAGNOSTICS"] = "1"
        app.launchEnvironment["OPENBOT_SHELL_TEST_NAME"] = "\(testName)-\(moment)"
        if let base = base { app.launchEnvironment["OPENBOT_BASE_URL"] = base }
        if reset { app.launchEnvironment["OPENBOT_SHELL_RESET"] = "1" }
        if plain { app.launchEnvironment["OPENBOT_SHELL_PLAIN_WEBVIEW"] = "1" }
        if ephemeral { app.launchEnvironment["OPENBOT_SHELL_EPHEMERAL_SIGN_IN"] = "1" }
        if auto { app.launchEnvironment["OPENBOT_SHELL_HANDOFF_AUTO"] = "1" }
        for (key, value) in extra { app.launchEnvironment[key] = value }
        app.launch()
        return app
    }

    /// "testFoo" from "-[ShellFlowUITests testFoo]".
    var testName: String {
        let raw = name
        if let space = raw.lastIndex(of: " ") {
            return String(raw[raw.index(after: space)...]).trimmingCharacters(in: CharacterSet(charactersIn: "]"))
        }
        return raw
    }

    /// Signs in on mock stack A through the sheet in auto mode and waits for the tabs.
    func launchSignedIn(moment: String = "signed-in") -> XCUIApplication {
        let app = launch(base: ShellTestCase.mockA, moment: moment, auto: true)
        let button = app.buttons["sign-in-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "no native Sign in button")
        button.tap()
        let home = tab(app, .home)
        if !home.waitForExistence(timeout: 45) {
            screenshot("\(moment)-sign-in-did-not-finish")
            XCTFail("signing in on the mock did not reach the tabs; state: \(debugState(app))")
        }
        return app
    }

    /// Puts the software keyboard away if it is up (a conversation focuses its message box when it
    /// opens): taps `neutral`, then swipes the page down.
    func dismissKeyboardIfUp(_ app: XCUIApplication, tapping neutral: XCUIElement? = nil) {
        // iOS's one-time "slide to type" tip sits on the keyboard: close it first.
        let tip = app.keyboards.buttons.matching(NSPredicate(format: "label == 'Continue'")).firstMatch
        if tip.exists { tip.tap() }
        guard app.keyboards.firstMatch.exists else { return }
        note("the keyboard was up; putting it away")
        if let neutral = neutral, neutral.exists, neutral.isHittable { neutral.tap() }
        // A tap on an empty part of the page blurs the field (a page that does not scroll ignores a drag).
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 2) {
            app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 2) {
            app.webViews.firstMatch.swipeDown()
        }
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 3) {
            note("the keyboard stayed up")
        }
    }

    /// Taps the message box once the skeleton is gone (a tap under it lands on the skeleton) and
    /// waits for the software keyboard, tapping a second time if the first did not raise it.
    @discardableResult
    func focusComposer(_ app: XCUIApplication, _ composer: XCUIElement) -> Bool {
        _ = app.descendants(matching: .any)["loading-skeleton"].waitForNonExistence(timeout: 10)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { return true }
        composer.tap()
        if keyboard.waitForExistence(timeout: 5) { return true }
        note("the first tap on the message box raised no keyboard; tapping again")
        composer.tap()
        return keyboard.waitForExistence(timeout: 5)
    }

    /// A person's drag down the page, from the empty top of the web view to near its bottom (a drag
    /// that starts on the focused message box moves the text, not the page).
    func dragPageDown(_ app: XCUIApplication) {
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
    }

    /// True in the video workflow: scenes are paced for watching and the background step is short.
    var videoMode: Bool { ProcessInfo.processInfo.environment["OPENBOT_SHELL_VIDEO_MODE"] == "1" }

    // MARK: - Elements

    enum Tab: String { case conversations, home, bots }

    func tab(_ app: XCUIApplication, _ tab: Tab) -> XCUIElement {
        app.buttons["tab-\(tab.rawValue)"]
    }

    /// Text in the web view: a static text, or a link or button whose name holds it (a list row).
    func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        let web = app.webViews.firstMatch
        let staticText = web.staticTexts.matching(predicate).firstMatch
        if staticText.exists { return staticText }
        let link = web.links.matching(predicate).firstMatch
        if link.exists { return link }
        let button = web.buttons.matching(predicate).firstMatch
        if button.exists { return button }
        return staticText
    }

    func debugState(_ app: XCUIApplication) -> String {
        let element = app.staticTexts["debug-state"]
        return element.exists ? element.label : "(no debug-state)"
    }

    /// Polls the DEBUG state label until it contains `fragment`.
    @discardableResult
    func waitForState(_ app: XCUIApplication, _ fragment: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if debugState(app).contains(fragment) { return true }
            usleep(300_000)
        } while Date() < deadline
        return false
    }

    func stateValue(_ app: XCUIApplication, _ key: String) -> String? {
        for part in debugState(app).split(separator: " ") {
            let pieces = part.split(separator: "=", maxSplits: 1)
            if pieces.count == 2, pieces[0] == key { return String(pieces[1]) }
        }
        return nil
    }

    /// The first of `elements` to exist within `timeout`, or nil.
    func firstExisting(_ elements: [XCUIElement], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for element in elements where element.exists { return element }
            usleep(400_000)
        } while Date() < deadline
        return nil
    }

    /// The normal mobile web app's own navigation: the sidebar toggle.
    func assertNoWebNavigation(_ app: XCUIApplication, _ moment: String) {
        for label in ["Show sidebar", "Hide sidebar", "Toggle Sidebar"] {
            XCTAssertFalse(webElement(app, label: label).exists, "\(moment): the web app drew its own '\(label)' button")
        }
    }

    static let lockHeading = "Cannot reach the OpenBot backend"
    static let lockMessage = "For security purposes, this application can only be used when connected to the OpenBot backend. Please check your internet connection, VPC configuration and network settings to make sure this device can reach the OpenBot backend. Contact your system administrator if you are unable to connect."

    func lockScreen(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["offline-lock"]
    }

    /// The lock screen is up, with its exact words, Try again, and the expected reason.
    func assertLockScreen(_ app: XCUIApplication, reason: String) {
        let lock = lockScreen(app)
        XCTAssertTrue(lock.exists, "no lock screen")
        let heading = app.staticTexts["offline-lock-heading"]
        let message = app.staticTexts["offline-lock-message"]
        XCTAssertTrue(heading.exists, "the lock screen has no heading")
        XCTAssertEqual(heading.exists ? heading.label : "", ShellTestCase.lockHeading, "the lock screen's heading")
        XCTAssertTrue(message.exists, "the lock screen has no text")
        XCTAssertEqual(message.exists ? message.label : "", ShellTestCase.lockMessage, "the lock screen's text")
        XCTAssertTrue(app.buttons["support-email"].exists, "the lock screen has no support link")
        XCTAssertTrue(app.buttons["retry-button"].exists, "the lock screen has no Try again")
        XCTAssertEqual(lock.value as? String, reason, "the lock screen's reason")
        XCTAssertTrue(debugState(app).contains("lock=\(reason)"), "state: \(debugState(app))")
    }

    /// "Type: label" lines of everything under `element`, read from ONE snapshot (its
    /// debugDescription), so elements that come and go cannot fail the test.
    func labels(in element: XCUIElement, limit: Int = 150) -> [String] {
        guard element.exists else { return [] }
        let regex = try? NSRegularExpression(pattern: "^\\s*([A-Za-z]+),.*?label: '((?:[^'\\\\]|\\\\.)*)'", options: [.anchorsMatchLines])
        let text = element.debugDescription
        var result: [String] = []
        regex?.enumerateMatches(in: text, range: NSRange(text.startIndex..., in: text)) { match, _, stop in
            guard let match = match, let type = Range(match.range(at: 1), in: text),
                  let label = Range(match.range(at: 2), in: text) else { return }
            result.append("\(text[type]): \(text[label])")
            if result.count >= limit { stop.pointee = true }
        }
        return result
    }

    func webLabels(_ app: XCUIApplication, limit: Int = 120) -> [String] {
        labels(in: app.webViews.firstMatch, limit: limit)
    }

    /// Any element in the web view whose label is exactly `label` (a button, a pop-up button, a menu item, a link).
    func webElement(_ app: XCUIApplication, label: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    // MARK: - Evidence

    func screenshot(_ moment: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = moment
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func attachText(_ moment: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = moment
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// A line the CI summary picks up (never put a secret or personal data in one).
    func note(_ text: String) {
        print("SHELL_NOTE \(testName): \(text)")
    }
}
