import SwiftUI
import UIKit
import WebKit

/// The signed-in layout, in UIKit so the frames are exact: the web view on top, the native tab bar
/// (a real UITabBar: Chats, Home, Bots) under it. The web view ends where the tab bar's
/// frame starts, so nothing of the page sits under the bar; while the bar is hidden (keyboard,
/// sign-in) the web view takes the whole height. The bar's own background is clear: the page's
/// colour, painted behind everything by ShellView, shows through it.
struct ShellContentHost: UIViewRepresentable {
    let webView: WKWebView
    let webVisible: Bool
    let tabBarVisible: Bool
    let selected: ShellTab
    let isDark: Bool?
    let onSelect: (ShellTab) -> Void
    let onLayout: (_ tabBarHeight: CGFloat, _ webFrame: CGRect) -> Void

    func makeUIView(context: Context) -> ShellContentView {
        let view = ShellContentView(webView: webView)
        update(view)
        return view
    }

    func updateUIView(_ view: ShellContentView, context: Context) {
        update(view)
    }

    private func update(_ view: ShellContentView) {
        view.onSelect = onSelect
        view.onLayout = onLayout

        view.setWebVisible(webVisible)
        view.setTabBarVisible(tabBarVisible)
        view.select(selected)
        view.setDark(isDark)
    }
}

final class ShellContentView: UIView, UITabBarDelegate {
    let webView: WKWebView
    let tabBar = UITabBar()
    var onSelect: ((ShellTab) -> Void)?
    var onLayout: ((CGFloat, CGRect) -> Void)?
    /// How much of this view the software keyboard covers (0 when it is down or a hardware keyboard
    /// is used without one). The web view's bottom follows the keyboard's top edge.
    private var keyboardOverlap: CGFloat = 0
    private var keyboardObservers: [NSObjectProtocol] = []

    private var tabBarVisible = false
    private var lastReported: (CGFloat, CGRect)?

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        observeKeyboard()
        backgroundColor = .clear
        webView.removeFromSuperview()
        addSubview(webView)

        // UIKit measures unselected titles when the items are installed, before our first layout.
        // The actual container takes over sizing on layout, including for multitasking and rotation.
        tabBar.frame.size = CGSize(width: max(webView.bounds.width, UIScreen.main.bounds.width), height: 49)
        tabBar.items = ShellTab.allCases.enumerated().map { index, tab in
            let item = UITabBarItem(
                title: tab.title,
                image: UIImage(systemName: tab.symbol),
                selectedImage: UIImage(systemName: tab.selectedSymbol)
            )
            item.tag = index
            item.accessibilityIdentifier = "tab-\(tab.rawValue)"
            return item
        }
        let appearance = UITabBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.shadowColor = .clear
        for layout in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance] {
            layout.normal.titleTextAttributes = [.foregroundColor: UIColor.secondaryLabel]
            layout.selected.titleTextAttributes = [.foregroundColor: UIColor.label]
        }
        tabBar.standardAppearance = appearance
        tabBar.scrollEdgeAppearance = appearance
        tabBar.tintColor = .label
        tabBar.unselectedItemTintColor = .secondaryLabel
        tabBar.delegate = self
        tabBar.accessibilityIdentifier = "shell-tab-bar"
        tabBar.isHidden = true
        addSubview(tabBar)

    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func setWebVisible(_ visible: Bool) {
        if webView.isHidden == visible {
            webView.isHidden = !visible
            webView.accessibilityElementsHidden = !visible
        }
    }

    func setTabBarVisible(_ visible: Bool) {
        guard visible != tabBarVisible else { return }
        tabBarVisible = visible
        tabBar.isHidden = !visible
        setNeedsLayout()
    }

    func select(_ tab: ShellTab) {
        guard let index = ShellTab.allCases.firstIndex(of: tab), let items = tabBar.items, index < items.count else { return }
        if tabBar.selectedItem !== items[index] { tabBar.selectedItem = items[index] }
    }

    func setDark(_ dark: Bool?) {
        let style: UIUserInterfaceStyle
        switch dark {
        case .some(true): style = .dark
        case .some(false): style = .light
        case .none: style = .unspecified
        }
        if tabBar.overrideUserInterfaceStyle != style { tabBar.overrideUserInterfaceStyle = style }
    }

    /// This view runs down to the screen's bottom edge. The bar sits at the bottom and takes the
    /// home indicator's strip into its height, as a tab bar does in UIKit; without the bar the web
    /// view stops above that strip.
    override func layoutSubviews() {
        super.layoutSubviews()
        let bottomInset = safeAreaInsets.bottom
        var barHeight: CGFloat = 0
        // With the keyboard up the bar is hidden and the web view ends at the keyboard's top.
        let showBar = tabBarVisible && keyboardOverlap == 0
        tabBar.isHidden = !showBar
        if showBar {
            let fitted = tabBar.sizeThatFits(CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude)).height
            barHeight = max(fitted, 49 + bottomInset)
        }
        if showBar && bounds.width > 0 {
            tabBar.frame = CGRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
        }
        let webBottom: CGFloat
        if keyboardOverlap > 0 {
            webBottom = bounds.height - keyboardOverlap
        } else {
            webBottom = bounds.height - (showBar ? barHeight : bottomInset)
        }
        let webFrame = CGRect(x: 0, y: 0, width: bounds.width, height: max(webBottom, 0))
        if webView.frame != webFrame { webView.frame = webFrame }
        if lastReported == nil || lastReported!.0 != barHeight || lastReported!.1 != webFrame {
            lastReported = (barHeight, webFrame)
            let report = onLayout
            let global = convert(webFrame, to: nil)
            DispatchQueue.main.async { report?(barHeight, global) }
        }
    }

    // MARK: - The keyboard

    deinit {
        for observer in keyboardObservers { NotificationCenter.default.removeObserver(observer) }
    }

    private func observeKeyboard() {
        let center = NotificationCenter.default
        let change: (Notification) -> Void = { [weak self] note in self?.keyboardChanged(note, hiding: false) }
        keyboardObservers.append(center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main, using: change))
        keyboardObservers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] note in
            self?.keyboardChanged(note, hiding: true)
        })
        keyboardObservers.append(center.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.resetLeftoverScroll()
        })
        keyboardObservers.append(center.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] _ in
            self?.resetLeftoverScroll()
        })
    }

    private func keyboardChanged(_ note: Notification, hiding: Bool) {
        let info = note.userInfo ?? [:]
        var overlap: CGFloat = 0
        if !hiding, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, window != nil {
            let local = convert(end, from: UIScreen.main.coordinateSpace)
            if local.height > 0, local.minY < bounds.maxY {
                overlap = max(0, bounds.maxY - local.minY)
            }
        }
        guard overlap != keyboardOverlap else { return }
        keyboardOverlap = overlap
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        setNeedsLayout()
        UIView.animate(withDuration: duration, delay: 0,
                       options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
            self.layoutIfNeeded()
        }
    }

    /// WebKit scrolls its scroll view to keep the caret in sight while the keyboard comes and goes;
    /// once the web view fits above the keyboard (or the keyboard is gone) a page that does not
    /// scroll as a whole must sit at the top again, or it stays shifted up with a gap.
    private func resetLeftoverScroll() {
        let scrollView = webView.scrollView
        if scrollView.contentSize.height <= scrollView.bounds.height + 1, scrollView.contentOffset != .zero {
            scrollView.setContentOffset(.zero, animated: false)
        }
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    // Called for the selected tab too: tapping it again goes back to the tab's page.
    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        let tabs = ShellTab.allCases
        guard item.tag >= 0, item.tag < tabs.count else { return }
        onSelect?(tabs[item.tag])
    }
}
