import SwiftUI
import UIKit
import WebKit

/// The signed-in layout, in UIKit so the frames are exact: the web view on top, the native tab bar
/// (a real UITabBar: Conversations, Home, Bots) under it. The web view ends where the tab bar's
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
    let onReload: () -> Void
    let onSignOut: () -> Void

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
        view.onReload = onReload
        view.onSignOut = onSignOut
        view.setWebVisible(webVisible)
        view.setTabBarVisible(tabBarVisible)
        view.select(selected)
        view.setDark(isDark)
    }
}

final class ShellContentView: UIView, UITabBarDelegate {
    let webView: WKWebView
    let tabBar = UITabBar()
    /// The detached round button beside the tab bar: Reload and Sign out, whatever the web app is.
    let moreButton = UIButton(type: .system)
    private let moreBackground = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    var onSelect: ((ShellTab) -> Void)?
    var onLayout: ((CGFloat, CGRect) -> Void)?
    var onReload: (() -> Void)?
    var onSignOut: (() -> Void)?
    private static let moreSize: CGFloat = 52
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

        moreBackground.isUserInteractionEnabled = false
        moreBackground.clipsToBounds = true
        moreBackground.layer.cornerRadius = ShellContentView.moreSize / 2
        moreBackground.isHidden = true
        addSubview(moreBackground)
        moreButton.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        moreButton.tintColor = .label
        moreButton.layer.cornerRadius = ShellContentView.moreSize / 2
        moreButton.layer.shadowColor = UIColor.black.cgColor
        moreButton.layer.shadowOpacity = 0.12
        moreButton.layer.shadowRadius = 10
        moreButton.layer.shadowOffset = CGSize(width: 0, height: 3)
        moreButton.accessibilityLabel = "More"
        moreButton.accessibilityIdentifier = "more-button"
        moreButton.showsMenuAsPrimaryAction = true
        moreButton.menu = UIMenu(children: [
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.onReload?() },
            UIAction(title: "Sign out", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in
                self?.onSignOut?()
            },
        ])
        moreButton.isHidden = true
        addSubview(moreButton)
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
        moreButton.isHidden = !visible
        moreBackground.isHidden = !visible
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
        if tabBar.overrideUserInterfaceStyle != style {
            tabBar.overrideUserInterfaceStyle = style
            moreButton.overrideUserInterfaceStyle = style
            moreBackground.overrideUserInterfaceStyle = style
        }
    }

    /// This view runs down to the screen's bottom edge. The bar sits at the bottom and takes the
    /// home indicator's strip into its height, as a tab bar does in UIKit; without the bar the web
    /// view stops above that strip.
    override func layoutSubviews() {
        super.layoutSubviews()
        let bottomInset = safeAreaInsets.bottom
        var barHeight: CGFloat = 0
        if tabBarVisible {
            let fitted = tabBar.sizeThatFits(CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude)).height
            barHeight = max(fitted, 49 + bottomInset)
        }
        // The tab bar leaves room at the trailing end for the round More button, which sits level
        // with the bar's buttons (iOS 26 draws them as a floating group near the bar's top).
        let size = ShellContentView.moreSize
        let trailingRoom = size + 16
        tabBar.frame = CGRect(x: 0, y: bounds.height - barHeight, width: max(bounds.width - trailingRoom, 0), height: barHeight)
        // Measured on iOS 26.5: the floating buttons' centre is 31 pt below the bar's top.
        let buttonsCenterY = tabBar.frame.minY + min(31, barHeight / 2)
        let moreFrame = CGRect(x: bounds.width - size - 12, y: buttonsCenterY - size / 2, width: size, height: size)
        moreButton.frame = moreFrame
        moreBackground.frame = moreFrame
        let webBottom = bounds.height - (tabBarVisible ? barHeight : bottomInset)
        let webFrame = CGRect(x: 0, y: 0, width: bounds.width, height: max(webBottom, 0))
        if webView.frame != webFrame { webView.frame = webFrame }
        if lastReported == nil || lastReported!.0 != barHeight || lastReported!.1 != webFrame {
            lastReported = (barHeight, webFrame)
            let report = onLayout
            let global = convert(webFrame, to: nil)
            DispatchQueue.main.async { report?(barHeight, global) }
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
