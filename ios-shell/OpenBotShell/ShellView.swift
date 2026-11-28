import SwiftUI
import UIKit
import WebKit

/// The whole app, back to front: the page's background colour (behind the status bar and the tab
/// bar), the web view between the top safe area and the tab bar, the native sign-in screen, and the
/// lock screen (no network, or the web app did not load) over everything.
struct ShellView: View {
    let shell: ShellController
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        ZStack {
            Color(uiColor: model.chromeBackground)
                .ignoresSafeArea()

            content
                .accessibilityHidden(model.showsLock)

            if model.showsSkeleton && model.webFrame.height > 0 {
                // Exactly over the web view: the status bar strip and the tab bar stay as they are.
                GeometryReader { _ in
                    LoadingSkeleton()
                        .frame(width: model.webFrame.width, height: model.webFrame.height)
                        .position(x: model.webFrame.midX, y: model.webFrame.midY)
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .transition(.opacity)
            }

            if model.showsSignInScreen {
                SignInScreen(
                    launching: model.phase == .launching,
                    busy: model.signIn != .idle,
                    message: model.signInMessage,
                    signIn: { shell.signIn() }
                )
                .accessibilityHidden(model.showsLock)
            }

            if model.showsLock {
                OfflineLockScreen(reason: model.lockReason, retry: { shell.retryNow() })
            }

            #if DEBUG
            DebugStateLabel(text: model.debugState)
            #endif
        }
        .animation(.easeOut(duration: 0.2), value: model.showsSkeleton)
        .onChange(of: colorScheme) { _ in
            // A page that follows the system theme repaints itself; read its colours again.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { shell.refreshChrome() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.phase == .plain {
            // Step 1's bare web view, edge to edge (DEBUG probe mode).
            WebViewHost(webView: shell.web.webView, visible: true)
                .ignoresSafeArea()
        } else {
            VStack(spacing: 0) {
                if model.showsWebSignInBar {
                    WebSignInBar(background: Color(uiColor: model.chromeBackground), cancel: { shell.cancelWebSignIn() })
                }
                ShellContentHost(
                    webView: shell.web.webView,
                    webVisible: model.webVisible,
                    tabBarVisible: model.showsTabBar,
                    selected: model.selectedTab,
                    isDark: model.pageIsDark,
                    onSelect: { tab in shell.selectTab(tab) },
                    onLayout: { height, frame in shell.layoutChanged(tabBarHeight: height, webFrame: frame) },
                    onReload: { shell.reloadFromMenu() },
                    onSignOut: { shell.confirmSignOut() }
                )
                // Down to the screen's edge: the tab bar takes the home indicator's strip.
                .ignoresSafeArea(.container, edges: .bottom)
            }
            // WKWebView moves its own content out of the keyboard's way, as Safari does.
            .ignoresSafeArea(.keyboard)
        }
    }
}

/// Hosts the one WKWebView full screen (the DEBUG plain mode).
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    let visible: Bool

    func makeUIView(context: Context) -> WKWebView {
        webView.isHidden = !visible
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// The web sign-in fallback's top bar: a way back to the native sign-in screen.
struct WebSignInBar: View {
    let background: Color
    let cancel: () -> Void

    var body: some View {
        HStack {
            Button("Cancel", action: cancel)
                .accessibilityIdentifier("web-sign-in-cancel")
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(background)
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
