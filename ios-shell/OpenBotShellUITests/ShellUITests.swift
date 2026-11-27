import XCTest

/// Runs the shell against the local probe site (ios-shell/Probe/serve.py must be running on the
/// Mac that runs the simulator) and against the hosted web app.
final class ShellUITests: XCTestCase {
    private let probeBase = "http://127.0.0.1:8765/"

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        XCUIDevice.shared.appearance = .light
    }

    // MARK: - Helpers

    private func launch(baseURL: String?, test: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OPENBOT_SHELL_DIAGNOSTICS"] = "1"
        app.launchEnvironment["OPENBOT_SHELL_TEST_NAME"] = test
        if let baseURL = baseURL {
            app.launchEnvironment["OPENBOT_BASE_URL"] = baseURL
        }
        app.launch()
        return app
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachText(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func text(beginningWith prefix: String, in element: XCUIElement) -> XCUIElement {
        element.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func labels(of element: XCUIElement) -> [String] {
        element.staticTexts.allElementsBoundByIndex.map { $0.label }
    }

    private func firstNumber(before word: String, in text: String) -> Int? {
        guard let regex = try? NSRegularExpression(pattern: "(\\d+) \(word)") else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              let numberRange = Range(match.range(at: 1), in: text) else { return nil }
        return Int(text[numberRange])
    }

    // MARK: - Tests

    func testProbeSite() throws {
        let app = launch(baseURL: probeBase, test: "testProbeSite")
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "the web view never appeared")

        let done = text(beginningWith: "probe done", in: web)
        let finished = done.waitForExistence(timeout: 60)
        screenshot("probe-site")
        let rows = labels(of: web)
        attachText("probe-rows", rows.joined(separator: "\n"))
        for row in rows { print("PROBE_ROW \(row)") }
        guard finished else {
            XCTFail("the probe page never showed 'probe done'")
            return
        }
        let summary = done.label
        print("PROBE_SUMMARY \(summary)")
        XCTAssertEqual(firstNumber(before: "fail", in: summary), 0,
                       "probe rows failed: \(rows.filter { $0.contains(": fail") })")

        let button = web.buttons["Open popup"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10), "no Open popup button")
        button.tap()
        let popup = text(beginningWith: "popup page loaded", in: web)
        let popupShown = popup.waitForExistence(timeout: 20)
        screenshot("probe-popup")
        attachText("probe-popup-texts", labels(of: web).joined(separator: "\n"))
        XCTAssertTrue(popupShown, "window.open did not load the popup page in the same web view")
    }

    func testLoadsHostedWebApp() throws {
        let app = launch(baseURL: nil, test: "testLoadsHostedWebApp")
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "the web view never appeared")

        let retry = app.buttons["retry-button"]
        var hasContent = false
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            if retry.exists { break }
            if web.staticTexts.count > 0 || web.links.count > 0 || web.buttons.count > 0 || web.textFields.count > 0 {
                hasContent = true
                break
            }
            sleep(2)
        }

        if retry.exists {
            screenshot("hosted-error-overlay")
            let message = app.staticTexts.allElementsBoundByIndex.map { $0.label }.joined(separator: " | ")
            attachText("hosted-error-overlay-texts", message)
            throw XCTSkip("my.open.bot did not load on this runner; the shell showed its error overlay: \(message)")
        }

        // Let redirects, hydration and late requests settle.
        sleep(8)
        screenshot("hosted-light")
        let lightDump = web.debugDescription
        attachText("hosted-webview-debugDescription-light", lightDump)
        print("HOSTED_DEBUG_BEGIN\n\(lightDump)\nHOSTED_DEBUG_END")
        XCUIDevice.shared.appearance = .dark
        sleep(3)
        screenshot("hosted-dark")
        attachText("hosted-webview-debugDescription-dark", web.debugDescription)
        XCUIDevice.shared.appearance = .light

        if retry.exists {
            throw XCTSkip("my.open.bot failed after the first paint; see the hosted-dark screenshot")
        }
        XCTAssertTrue(hasContent, "the web view showed no web content within 60 s")
    }

    func testOfflineShowsRetry() throws {
        // Nothing listens on 8799. Port 9 (the first choice) is on WebKit's list of restricted
        // ports, and WKWebView did not report anything at all for it, so it cannot test the overlay.
        let app = launch(baseURL: "http://127.0.0.1:8799/", test: "testOfflineShowsRetry")
        let retry = app.buttons["retry-button"]
        let shown = retry.waitForExistence(timeout: 30)
        screenshot("offline-error-overlay")
        XCTAssertTrue(shown, "the native error overlay with retry-button did not appear")
        if shown {
            retry.tap()
            XCTAssertTrue(app.buttons["retry-button"].waitForExistence(timeout: 30),
                          "after Try again the overlay should come back, since nothing listens")
        }
    }

    func testSessionSurvivesRelaunch() throws {
        var app = launch(baseURL: probeBase + "persist.html?reset=1", test: "testSessionSurvivesRelaunch-first")
        var web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        let firstVisit = text(beginningWith: "returning visitor:", in: web)
        XCTAssertTrue(firstVisit.waitForExistence(timeout: 30), "persist.html never answered")
        XCTAssertTrue(text(beginningWith: "state saved", in: web).waitForExistence(timeout: 15),
                      "persist.html never saved its cookie and localStorage value")
        screenshot("persist-first-launch")
        attachText("persist-first-launch-texts", labels(of: web).joined(separator: "\n"))
        XCTAssertEqual(firstVisit.label, "returning visitor: no", "the reset visit should be a first visit")

        // Give WebKit time to write cookies and localStorage to disk before the process is killed.
        sleep(5)
        app.terminate()

        app = launch(baseURL: probeBase + "persist.html", test: "testSessionSurvivesRelaunch-second")
        web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        let secondVisit = text(beginningWith: "returning visitor:", in: web)
        XCTAssertTrue(secondVisit.waitForExistence(timeout: 30), "persist.html never answered after relaunch")
        screenshot("persist-after-relaunch")
        let texts = labels(of: web)
        attachText("persist-after-relaunch-texts", texts.joined(separator: "\n"))
        print("PERSIST_RESULT \(texts.joined(separator: " | "))")
        XCTAssertEqual(secondVisit.label, "returning visitor: yes",
                       "cookie or localStorage did not survive relaunch: \(texts)")
    }
}
