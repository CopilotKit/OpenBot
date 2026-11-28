import Combine
import SwiftUI
import UIKit

/// UIKit app and scene delegates, so the root view controller is ours: it sets the status bar's
/// style to match the page (a SwiftUI App cannot).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var shell: ShellController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let config = ShellConfig.fromEnvironment()
        let shell = ShellController(config: config)
        let window = UIWindow(windowScene: windowScene)
        if config.forceDark { window.overrideUserInterfaceStyle = .dark }
        // Shows through before the first paint: the system background, so dark mode never flashes white.
        window.backgroundColor = .systemBackground
        window.rootViewController = ShellHostingController(shell: shell)
        window.makeKeyAndVisible()
        self.window = window
        self.shell = shell
        shell.start(window: window)
    }
}

/// Hosts ShellView and answers the status bar's style from the model.
final class ShellHostingController: UIHostingController<ShellView> {
    private let model: AppModel
    private var subscription: AnyCancellable?

    init(shell: ShellController) {
        model = shell.model
        super.init(rootView: ShellView(shell: shell, model: shell.model))
        subscription = model.objectWillChange.sink { [weak self] _ in
            // objectWillChange fires before the change lands: ask again on the next turn.
            DispatchQueue.main.async { self?.setNeedsStatusBarAppearanceUpdate() }
        }
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        switch model.chromeIsDark {
        case .some(true): return .lightContent
        case .some(false): return .darkContent
        case .none: return .default
        }
    }
}
