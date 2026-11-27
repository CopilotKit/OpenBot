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

    // MARK: - Elements

    enum Tab: String { case conversations, home, bots }

    func tab(_ app: XCUIApplication, _ tab: Tab) -> XCUIElement {
        app.buttons["tab-\(tab.rawValue)"]
    }

    func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
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
            XCTAssertFalse(app.webViews.buttons[label].exists, "\(moment): the web app drew its own '\(label)' button")
        }
    }

    func webLabels(_ app: XCUIApplication, limit: Int = 120) -> [String] {
        let web = app.webViews.firstMatch
        guard web.exists else { return [] }
        var labels: [String] = []
        for element in web.descendants(matching: .any).allElementsBoundByIndex.prefix(400) {
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty { labels.append("\(element.elementType.rawValue): \(label)") }
            if labels.count >= limit { break }
        }
        return labels
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
