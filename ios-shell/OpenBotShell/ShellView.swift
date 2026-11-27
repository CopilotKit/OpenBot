import SwiftUI
import UIKit
import WebKit

/// The whole app, back to front: the page's background colour (behind the status bar and the tab
/// bar), the web view between the top safe area and the tab bar, the load-failure overlay, the
/// native sign-in screen, and the offline lock over everything.
struct ShellView: View {
    let shell: ShellController
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        ZStack {
            Color(uiColor: model.chromeBackground)
                .ignoresSafeArea()

            content
                .accessibilityHidden(model.offline)

            if model.showsSignInScreen {
                SignInScreen(
                    launching: model.phase == .launching,
                    busy: model.signIn != .idle,
                    message: model.signInMessage,
                    signIn: { shell.signIn() }
                )
                .accessibilityHidden(model.offline)
            }

            if model.offline {
                OfflineLockScreen()
            }

            #if DEBUG
            DebugStateLabel(text: model.debugState)
            #endif
        }
        .onChange(of: colorScheme) { _ in
            // A page that follows the system theme repaints itself; read its colours again.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { shell.refreshChrome() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.phase == .plain {
            // Step 1's bare web view, edge to edge (DEBUG probe mode).
            ZStack {
                WebViewHost(webView: shell.web.webView, visible: true)
                if let message = model.loadError {
                    LoadErrorOverlay(message: message) { shell.retryLoad() }
                }
            }
            .ignoresSafeArea()
        } else {
            VStack(spacing: 0) {
                if model.showsWebSignInBar {
                    WebSignInBar(cancel: { shell.cancelWebSignIn() })
                }
                ZStack {
                    WebViewHost(webView: shell.web.webView, visible: model.webVisible)
                    if model.webVisible, let message = model.loadError {
                        LoadErrorOverlay(message: message) { shell.retryLoad() }
                    }
                }
                if model.showsTabBar {
                    TabBarView(
                        selected: model.selectedTab,
                        isDark: model.pageIsDark,
                        onSelect: { tab in shell.selectTab(tab) }
                    )
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            // WKWebView moves its own content out of the keyboard's way, as Safari does.
            .ignoresSafeArea(.keyboard)
        }
    }
}

/// Hosts the one WKWebView. Hidden (and so out of the accessibility tree) when it should not show.
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    let visible: Bool

    func makeUIView(context: Context) -> WKWebView {
        webView.isHidden = !visible
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if uiView.isHidden == visible { uiView.isHidden = !visible }
    }
}

/// The web sign-in fallback's top bar: a way back to the native sign-in screen.
struct WebSignInBar: View {
    let cancel: () -> Void

    var body: some View {
        HStack {
            Button("Cancel", action: cancel)
                .accessibilityIdentifier("web-sign-in-cancel")
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
    }
}

#if DEBUG
/// The model's state as an accessibility label, for UI tests. Not in release builds.
struct DebugStateLabel: View {
    let text: String

    var body: some View {
        VStack {
            HStack {
                Text(text)
                    .font(.system(size: 2))
                    .foregroundColor(.clear)
                    .frame(width: 2, height: 2)
                    .accessibilityLabel(text)
                    .accessibilityIdentifier("debug-state")
                Spacer()
            }
            Spacer()
        }
        .allowsHitTesting(false)
    }
}
#endif
