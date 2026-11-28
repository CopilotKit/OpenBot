import SwiftUI
import UIKit
import WebKit

/// The signed-in layout, in UIKit so the frames are exact: the web view on top, the native tab bar
/// (a real UITabBar: Conversations, Home, Bots) under it. The web view ends where the tab bar's
/// region starts, so nothing of the page sits under the bar; while the bar is hidden (keyboard,
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
    private var tabBarVisible = false
    private var lastReported: (CGFloat, CGRect)?

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        backgroundColor = .clear
        webView.removeFromSuperview()
        addSubview(webView)

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

    /// The bar's height without any safe-area part (this view already ends above the home indicator).
    private func tabBarHeight() -> CGFloat {
        let fitted = tabBar.sizeThatFits(CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude))
        return max(fitted.height - tabBar.safeAreaInsets.bottom, 49)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let barHeight: CGFloat = tabBarVisible ? tabBarHeight() : 0
        tabBar.frame = CGRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
        let webFrame = CGRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height - barHeight, 0))
        if webView.frame != webFrame { webView.frame = webFrame }
        if lastReported == nil || lastReported!.0 != barHeight || lastReported!.1 != webFrame {
            lastReported = (barHeight, webFrame)
            let report = onLayout
            let global = convert(webFrame, to: nil)
            DispatchQueue.main.async { report?(barHeight, global) }
        }
    }

    // Called for the selected tab too: tapping it again goes back to the tab's page.
    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        let tabs = ShellTab.allCases
        guard item.tag >= 0, item.tag < tabs.count else { return }
        onSelect?(tabs[item.tag])
    }
}
