import SwiftUI
import UIKit

/// The native tab bar: a real UITabBar with Conversations, Home and Bots. Its background is clear,
/// so the page's own background colour (painted behind it) shows through; it takes the page's
/// light or dark style.
struct TabBarView: UIViewRepresentable {
    let selected: ShellTab
    let isDark: Bool?
    let onSelect: (ShellTab) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect)
    }

    func makeUIView(context: Context) -> UITabBar {
        let bar = UITabBar()
        bar.items = ShellTab.allCases.enumerated().map { index, tab in
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
        appearance.shadowColor = UIColor.separator
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.tintColor = .label
        bar.unselectedItemTintColor = .secondaryLabel
        bar.delegate = context.coordinator
        bar.accessibilityIdentifier = "shell-tab-bar"
        apply(to: bar)
        return bar
    }

    func updateUIView(_ bar: UITabBar, context: Context) {
        context.coordinator.onSelect = onSelect
        apply(to: bar)
    }

    @available(iOS 16.0, *)
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITabBar, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        return CGSize(width: width, height: max(fitted.height, 49))
    }

    private func apply(to bar: UITabBar) {
        if let index = ShellTab.allCases.firstIndex(of: selected), let items = bar.items, index < items.count,
           bar.selectedItem !== items[index] {
            bar.selectedItem = items[index]
        }
        let style: UIUserInterfaceStyle
        switch isDark {
        case .some(true): style = .dark
        case .some(false): style = .light
        case .none: style = .unspecified
        }
        if bar.overrideUserInterfaceStyle != style { bar.overrideUserInterfaceStyle = style }
    }

    final class Coordinator: NSObject, UITabBarDelegate {
        var onSelect: (ShellTab) -> Void

        init(onSelect: @escaping (ShellTab) -> Void) {
            self.onSelect = onSelect
        }

        // Called for the selected tab too: tapping it again goes back to the tab's page.
        func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
            let tabs = ShellTab.allCases
            guard item.tag >= 0, item.tag < tabs.count else { return }
            onSelect(tabs[item.tag])
        }
    }
}
