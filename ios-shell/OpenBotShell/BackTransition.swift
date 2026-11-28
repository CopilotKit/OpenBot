import UIKit
import WebKit

/// The native feel of going back inside a tab, over the 1 live web view. The web app owns the
/// stacks; this keeps, per tab, a snapshot of each page under the current one (taken when the page
/// says `will-navigate` with direction "push"), so a swipe from the left edge can slide the live
/// page away with the finger and show the previous page beneath it, as a navigation stack does.
///
/// - Swipe: the web view follows the finger; the previous page's snapshot sits beneath with a
///   parallax offset and a dimming; the web view casts a shadow. Through past a third of the width
///   (or a quick flick) it completes: the snapshot is put on top, `openbot:back` is sent, and the
///   snapshot stays until the page's next `route` has drawn text, then fades in 0.15 s. Otherwise it
///   springs back.
/// - The header's Back (`will-navigate` with direction "back") plays the same slide without a finger.
/// - No snapshot (production, a page without `depth`, memory pressure, a cold start into a deep page)
///   or Reduce Motion: no slide, the page changes when the swipe ends.
final class BackTransition {
    private weak var webView: WKWebView?
    private let diagnostics: Diagnostics
    /// Snapshots of the pages under the current one, per tab, bottom first.
    private var stacks: [String: [UIImage?]] = [:]
    private(set) var currentTab: String = "home"
    private var under: UIView?
    private var cover: UIImageView?
    private var coverDeadline: DispatchWorkItem?
    private var memoryObserver: NSObjectProtocol?

    init(webView: WKWebView, diagnostics: Diagnostics) {
        self.webView = webView
        self.diagnostics = diagnostics
        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            // Kept as placeholders, so the depths stay right; the swipe falls back to no slide.
            for (tab, stack) in self.stacks { self.stacks[tab] = stack.map { _ in nil } }
            self.diagnostics.log("back-snapshots-dropped", [:])
        }
    }

    /// Whether a slide can play now: a snapshot of the page underneath, and motion allowed.
    var canSlide: Bool {
        !UIAccessibility.isReduceMotionEnabled && (stacks[currentTab]?.last ?? nil) != nil
    }

    // MARK: - Mirroring the page's stack

    /// A picture of the page as it is now, kept fresh (after each route, each drag or scroll), because
    /// taking one when `will-navigate` arrives is too late: the page waits 120 ms at most, and a
    /// snapshot on the simulator took longer, so it showed the new page (run 46165013120).
    private var latest: UIImage?
    /// When `latest` was asked for, and when the page last reported a route: a picture asked for
    /// before the last route is of another page and is not used.
    private var latestAskedAt = Date.distantPast
    private var lastRouteAt = Date.distantPast
    private var refreshWork: DispatchWorkItem?

    func refresh(after seconds: TimeInterval) {
        refreshWork?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, let webView = self.webView, self.under == nil, self.cover == nil else { return }
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = false
            let asked = Date()
            webView.takeSnapshot(with: config) { [weak self] image, _ in
                guard let self = self, let image = image, asked >= self.lastRouteAt else { return }
                self.latest = image
                self.latestAskedAt = asked
            }
        }
        refreshWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    /// The page is about to show a new page in this tab: keep the picture of what is on screen now,
    /// at once, so the page can go ahead.
    func willPush(tab: String, completion: @escaping () -> Void) {
        refreshWork?.cancel()
        // No fresh picture of this page: no slide for it later (better than the wrong page).
        stacks[tab, default: []].append(latestAskedAt >= lastRouteAt ? latest : nil)
        latest = nil
        completion()
    }

    /// A `route` with `depth`: drop or pad snapshots so this tab holds depth - 1 entries.
    func route(tab: String, depth: Int?) {
        currentTab = tab
        lastRouteAt = Date()
        if let depth = depth {
            var stack = stacks[tab] ?? []
            let wanted = max(0, depth - 1)
            if stack.count > wanted { stack.removeLast(stack.count - wanted) }
            while stack.count < wanted { stack.append(nil) }
            stacks[tab] = stack
        }
    }

    /// The page drew after a back: the cover goes.
    func pageDrawn() {
        removeCover(animated: true)
    }

    // MARK: - The slide

    func begin() {
        guard let webView = webView, let container = webView.superview, under == nil,
              let image = stacks[currentTab]?.last ?? nil else { return }
        let view = UIView(frame: restingFrame(webView))
        view.clipsToBounds = true
        let picture = UIImageView(image: image)
        picture.frame = view.bounds
        picture.contentMode = .scaleToFill
        view.addSubview(picture)
        let dim = UIView(frame: view.bounds)
        dim.backgroundColor = UIColor.black.withAlphaComponent(0.1)
        dim.tag = 1
        view.addSubview(dim)
        container.insertSubview(view, belowSubview: webView)
        under = view
        webView.layer.shadowColor = UIColor.black.cgColor
        webView.layer.shadowOpacity = 0.2
        webView.layer.shadowRadius = 8
        webView.layer.shadowOffset = .zero
        update(progress: 0)
    }

    func update(progress: CGFloat) {
        guard let webView = webView, let under = under else { return }
        let p = min(max(progress, 0), 1)
        let width = webView.bounds.width
        webView.transform = CGAffineTransform(translationX: p * width, y: 0)
        under.subviews.first?.transform = CGAffineTransform(translationX: -0.3 * width * (1 - p), y: 0)
        under.viewWithTag(1)?.alpha = 1 - p
    }

    /// Finishes the slide (through, then `back` runs) or springs back.
    func end(through: Bool, back: @escaping () -> Void) {
        guard let webView = webView, under != nil else {
            if through { back() }
            return
        }
        let width = webView.bounds.width
        UIView.animate(withDuration: through ? 0.25 : 0.2, delay: 0, options: [.curveEaseOut]) {
            self.update(progress: through ? 1 : 0)
            if through { webView.transform = CGAffineTransform(translationX: width, y: 0) }
        } completion: { _ in
            if through {
                // The previous page's picture covers the web view until the page has drawn it.
                self.showCover()
                back()
            }
            webView.transform = .identity
            webView.layer.shadowOpacity = 0
            self.under?.removeFromSuperview()
            self.under = nil
        }
    }

    /// The header's Back: the same slide, without a finger.
    func playBack(back: @escaping () -> Void) {
        guard canSlide else { back(); return }
        begin()
        end(through: true, back: back)
    }

    /// The web view's frame without the slide's transform.
    private func restingFrame(_ view: UIView) -> CGRect {
        CGRect(x: view.center.x - view.bounds.width / 2, y: view.center.y - view.bounds.height / 2,
               width: view.bounds.width, height: view.bounds.height)
    }

    private func showCover() {
        guard let webView = webView, let container = webView.superview,
              let image = stacks[currentTab]?.last ?? nil else { return }
        let view = UIImageView(image: image)
        view.frame = restingFrame(webView)
        view.contentMode = .scaleToFill
        container.insertSubview(view, aboveSubview: webView)
        cover?.removeFromSuperview()
        cover = view
        // Never stuck: gone after 2 s even if the page says nothing.
        coverDeadline?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.removeCover(animated: true) }
        coverDeadline = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: item)
    }

    private func removeCover(animated: Bool) {
        guard let view = cover else { return }
        cover = nil
        coverDeadline?.cancel()
        UIView.animate(withDuration: animated ? 0.15 : 0, animations: { view.alpha = 0 }) { _ in
            view.removeFromSuperview()
        }
    }
}
