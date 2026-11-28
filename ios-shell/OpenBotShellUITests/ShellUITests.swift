import XCTest

/// Step 1's tests: the bare web view against the local probe site and the hosted web app. They run
/// the app in its DEBUG plain mode (OPENBOT_SHELL_PLAIN_WEBVIEW=1: one full-screen web view, no
/// native sign-in screen and no tab bar), so the probe still measures the web view alone.
final class ShellUITests: ShellTestCase {
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

    func testProbeSite() throws {
        let app = launch(base: ShellTestCase.probe, moment: "probe", plain: true)
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
        let app = launch(base: nil, moment: "hosted", plain: true)
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
        attachText("hosted-webview-debugDescription-light", web.debugDescription)
        XCUIDevice.shared.appearance = .dark
        sleep(3)
        screenshot("hosted-dark")
        XCUIDevice.shared.appearance = .light

        if retry.exists {
            throw XCTSkip("my.open.bot failed after the first paint; see the hosted-dark screenshot")
        }
        XCTAssertTrue(hasContent, "the web view showed no web content within 60 s")
    }

    func testOfflineShowsRetry() throws {
        // Nothing listens on 8799 (connection refused: WebKit reports it at once). A failed load
        // shows the same lock screen as no network, with Try again.
        let app = launch(base: "http://127.0.0.1:8799/", moment: "refused", plain: true)
        let retry = app.buttons["retry-button"]
        let shown = retry.waitForExistence(timeout: 30)
        screenshot("load-failed-lock")
        XCTAssertTrue(shown, "the lock screen with retry-button did not appear")
        assertLockScreen(app, reason: "load-failed")
        if shown {
            retry.tap()
            sleep(2)
            XCTAssertTrue(app.buttons["retry-button"].waitForExistence(timeout: 30),
                          "after Try again the lock should stay, since nothing listens")
        }
    }

    func testWatchdogCatchesSilentLoad() throws {
        // Port 9 is on WebKit's list of restricted ports, and WKWebView reports nothing at all for
        // it (step 1 found this): only the 20 s watchdog can show the lock screen.
        let app = launch(base: "http://127.0.0.1:9/", moment: "silent", plain: true)
        let retry = app.buttons["retry-button"]
        let shown = retry.waitForExistence(timeout: 40)
        screenshot("watchdog-lock")
        XCTAssertTrue(shown, "the load watchdog did not show the lock screen within 40 s")
        assertLockScreen(app, reason: "load-failed")
    }

    func testSessionSurvivesRelaunch() throws {
        var app = launch(base: ShellTestCase.probe, moment: "first", plain: true,
                         extra: ["OPENBOT_BASE_URL": ShellTestCase.probe + "persist.html?reset=1"])
        var web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        let firstVisit = text(beginningWith: "returning visitor:", in: web)
        XCTAssertTrue(firstVisit.waitForExistence(timeout: 30), "persist.html never answered")
        XCTAssertTrue(text(beginningWith: "state saved", in: web).waitForExistence(timeout: 15),
                      "persist.html never saved its cookie and localStorage value")
        screenshot("persist-first-launch")
        XCTAssertEqual(firstVisit.label, "returning visitor: no", "the reset visit should be a first visit")

        // Give WebKit time to write cookies and localStorage to disk before the process is killed.
        sleep(5)
        app.terminate()

        app = launch(base: ShellTestCase.probe, moment: "second", reset: false, plain: true,
                     extra: ["OPENBOT_BASE_URL": ShellTestCase.probe + "persist.html"])
        web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        let secondVisit = text(beginningWith: "returning visitor:", in: web)
        XCTAssertTrue(secondVisit.waitForExistence(timeout: 30), "persist.html never answered after relaunch")
        screenshot("persist-after-relaunch")
        let texts = labels(of: web)
        print("PERSIST_RESULT \(texts.joined(separator: " | "))")
        XCTAssertEqual(secondVisit.label, "returning visitor: yes",
                       "cookie or localStorage did not survive relaunch: \(texts)")
    }

    // Review items F, K, M and G on the probe's edges page (plain mode: the probe is the web app's
    // origin here). Another site's dialog and a scheme opened by script are dropped; the page's own
    // alert is titled OpenBot; a tapped scheme outside mailto/tel/sms opens nothing; a download never
    // replaces the page; a 5xx on the web app's own origin shows the lock screen, not the error page.
    func testEdgesDialogsSchemesDownloadsAndServerErrors() throws {
        let app = launch(base: "http://127.0.0.1:8765/edges.html", moment: "edges", plain: true)
        XCTAssertTrue(webText(app, "Edges").waitForExistence(timeout: 20), "the edges page did not load")
        sleep(3)
        XCTAssertFalse(app.alerts.firstMatch.exists, "another site's alert, or the scripted scheme, put up a dialog")
        XCTAssertEqual(app.state, .runningForeground, "a scheme opened by script left the app")
        screenshot("1-edges-no-dialog")

        webElement(app, label: "Own alert").tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "the page's own alert did not show")
        XCTAssertEqual(alert.label, "OpenBot", "the page's alert is not titled OpenBot")
        screenshot("2-own-alert")
        alert.buttons["OK"].tap()

        webElement(app, label: "Custom scheme link").tap()
        sleep(2)
        XCTAssertEqual(app.state, .runningForeground, "a tapped custom scheme left the app")
        XCTAssertFalse(app.alerts.firstMatch.exists, "a tapped custom scheme put up a dialog")
        XCTAssertFalse(XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch.exists,
                       "a tapped custom scheme asked to open another app")

        webElement(app, label: "Download a file").tap()
        sleep(3)
        screenshot("3-after-download")
        XCTAssertTrue(webText(app, "Edges").exists, "the download replaced the page")
        let share = firstExisting([app.otherElements["ActivityListView"], app.buttons["Save to Files"],
                                   app.cells["Save to Files"], app.staticTexts["probe.txt"]], timeout: 5)
        note("download: share sheet shown \(share != nil)")
        XCTAssertNotNil(share, "no share sheet for the downloaded file")
        if share != nil {
            let close = firstExisting([app.buttons["Close"], app.navigationBars.buttons["Close"]], timeout: 2)
            if let close = close { close.tap() } else { app.swipeDown() }
            sleep(1)
        }

        webElement(app, label: "A server error page").tap()
        XCTAssertTrue(lockScreen(app).waitForExistence(timeout: 15), "a 503 on the web app's own origin did not lock")
        XCTAssertFalse(webText(app, "Service Unavailable").exists, "the raw error page is on screen")
        screenshot("4-server-error-lock")
        assertLockScreen(app, reason: "load-failed")
    }
}
