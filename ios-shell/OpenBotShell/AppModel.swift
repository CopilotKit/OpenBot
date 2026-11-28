import SwiftUI
import UIKit

/// Where the app is: deciding at launch, on the native sign-in screen, or signed in with the tabs.
/// `plain` is the DEBUG probe mode: step 1's bare full-screen web view.
enum Phase: String {
    case launching, signedOut, signedIn, plain
}

/// The sign-in in progress while signed out.
enum SignInStep: String {
    case idle
    /// Asking the server whether it has the sign-in hand-off.
    case probing
    /// The system sign-in sheet is up.
    case sheet
    /// The web view is loading the hand-off's enter URL; waiting for the page to say signed in.
    case entering
    /// No hand-off on this server: the web app's own sign-in, full screen in the web view.
    case webFallback
}

/// The native tab bar's tabs, left to right.
enum ShellTab: String, CaseIterable {
    case conversations, home, bots

    var path: String {
        switch self {
        case .conversations: return "/conversations"
        case .home: return "/"
        case .bots: return "/bots"
        }
    }

    var title: String {
        switch self {
        // The first tab reads "Chats" (as in OpenBot Desktop); its id stays `conversations`.
        case .conversations: return "Chats"
        case .home: return "Home"
        case .bots: return "Bots"
        }
    }

    /// The web app's own icons for these are Tabler's messages, home and bolt.
    var symbol: String {
        switch self {
        case .conversations: return "bubble.left.and.bubble.right"
        case .home: return "house"
        case .bots: return "bolt"
        }
    }

    var selectedSymbol: String { symbol + ".fill" }
}

/// The one observable model the views draw from. Changes are logged to diagnostics.
final class AppModel: ObservableObject {
    private let diagnostics: Diagnostics

    init(diagnostics: Diagnostics) {
        self.diagnostics = diagnostics
    }

    @Published var phase: Phase = .launching {
        didSet { if phase != oldValue { diagnostics.log("state", ["phase": phase.rawValue, "from": oldValue.rawValue]) } }
    }
    @Published var signIn: SignInStep = .idle {
        didSet { if signIn != oldValue { diagnostics.log("sign-in-phase", ["step": signIn.rawValue, "from": oldValue.rawValue]) } }
    }
    /// The short line under the Sign in button after a sign-in that did not finish.
    @Published var signInMessage: String?
    /// Wins over everything: the offline lock covers the whole app.
    @Published var offline = false {
        didSet { if offline != oldValue { diagnostics.log("offline", ["offline": offline]) } }
    }
    @Published var selectedTab: ShellTab = .home {
        didSet { if selectedTab != oldValue { diagnostics.log("tab-selected", ["tab": selectedTab.rawValue]) } }
    }
    /// The page's body background, painted behind the status bar and the tab bar.
    @Published var pageBackground: UIColor?
    /// Whether the page is in dark mode; nil until the page has said.
    @Published var pageIsDark: Bool?
    @Published var keyboardVisible = false
    /// The web app did not load (connected or not): the same lock screen as offline, retrying.
    @Published var loadFailed = false {
        didSet { if loadFailed != oldValue { diagnostics.log("load-failed", ["shown": loadFailed]) } }
    }
    /// How the last tab tap reached the page: "event" (openbot:open) or "load".
    @Published var lastNavigation = "none"
    @Published var mainFrameCommits = 0
    /// Times the web content process was restarted, and times the skeleton was put up (debug state).
    @Published var contentRestarts = 0
    @Published var skeletonsShown = 0
    /// Times sign-out cleared the site's data (debug state).
    @Published var siteDataClears = 0
    /// What the left-edge swipe does now: web (WebKit's history), page (`openbot:back`), none.
    @Published var backMode = "web"
    /// A main-frame page is loading and has not drawn yet: the native skeleton covers the web view.
    @Published var pageLoading = false {
        didSet { if pageLoading != oldValue { diagnostics.log("skeleton", ["shown": pageLoading]) } }
    }
    /// The web view's frame in the window, for laying the skeleton over it exactly.
    @Published var webFrame: CGRect = .zero
    /// The first segment of the page's path ("/", "/channel", "/sign"), for tests.
    @Published var webPathRoot = "-"

    // A self-hosted OpenBot (the first screen's quiet control).
    /// The host the app signs in to, as shown to a person.
    @Published var serverHost = ""
    @Published var selfHosted = false
    /// The address field is open, with what is typed in it, its error and whether it is being checked.
    @Published var addressOpen = false
    @Published var addressText = ""
    @Published var addressError: String?
    @Published var addressChecking = false
    /// The first screen opened over the lock screen by Change address.
    @Published var addressOverLock = false

    var showsSignInScreen: Bool {
        phase == .launching || (phase == .signedOut && signIn != .webFallback) || addressOverLock
    }

    var webVisible: Bool {
        switch phase {
        case .signedIn, .plain: return true
        case .signedOut: return signIn == .webFallback || signIn == .entering
        case .launching: return false
        }
    }

    var showsTabBar: Bool { phase == .signedIn && !keyboardVisible }
    var showsSkeleton: Bool { pageLoading && webVisible && !showsSignInScreen && !showsLock }
    var showsWebSignInBar: Bool { phase == .signedOut && signIn == .webFallback }

    /// The lock screen covers everything: no network, or the web app did not load.
    var showsLock: Bool { offline || loadFailed }
    /// Why the lock is up, for tests and diagnostics.
    var lockReason: String { offline ? "no-network" : (loadFailed ? "load-failed" : "none") }

    /// Whether the status bar and tab bar should be drawn for a dark page; nil: follow the system.
    var chromeIsDark: Bool? {
        if showsLock || showsSignInScreen { return nil }
        return pageIsDark
    }

    var chromeBackground: UIColor {
        if showsLock || showsSignInScreen { return .systemBackground }
        return pageBackground ?? .systemBackground
    }

    /// For UI tests (DEBUG only on screen).
    var debugState: String {
        "phase=\(phase.rawValue) signIn=\(signIn.rawValue) tab=\(selectedTab.rawValue) nav=\(lastNavigation) commits=\(mainFrameCommits) restarts=\(contentRestarts) skeletons=\(skeletonsShown) cleared=\(siteDataClears) back=\(backMode) server=\(serverHost) lock=\(lockReason) loading=\(pageLoading ? 1 : 0) keyboard=\(keyboardVisible ? 1 : 0) path=\(webPathRoot) dark=\(pageIsDark.map { $0 ? "1" : "0" } ?? "-")"
    }
}
