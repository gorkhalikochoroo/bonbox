import UIKit
import Capacitor

// UIScene lifecycle (required for apps built with the iOS 27 SDK — without it
// UIKit traps at launch in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
// Verbatim from Capacitor 8.5.3's iOS SPM template (@capacitor/cli
// assets/ios-spm-template.tar.gz). Deep links and universal links now arrive
// here instead of AppDelegate; SceneDelegateProxy forwards them to Capacitor
// (App plugin `appUrlOpen`, getLaunchUrl), holding cold-start links until the
// bridge view has appeared so plugins are loaded to receive them.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
