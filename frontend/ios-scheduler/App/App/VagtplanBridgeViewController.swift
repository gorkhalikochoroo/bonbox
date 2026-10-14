import UIKit
import WebKit
import Capacitor

/// Vagtplan's root view controller: Capacitor's bridge, kept edge to edge in an
/// iPadOS window that is not full screen.
///
/// capacitor.config.ts runs the staff app edge to edge (ios.contentInset
/// "never", StatusBar.overlaysWebView true): the web view is the whole window
/// and the page owns every safe area through env(safe-area-inset-*). Two
/// things broke that in a floating or tiled iPad window (1.6 build 23, iPad
/// Air 11 simulator, iPadOS 27; lab measurements in
/// bonbox-lab-state/vagtplan-inset):
///
/// 1. The StatusBar plugin re-frames the web view 0.1 s after every size
///    transition (StatusBar.swift resizeWebView). While overlaying it moves
///    the origin down by statusBarHeight − safeAreaInsets.top, a rule for the
///    old double-height in-call bar. A floating or bottom-tiled window reports
///    a 32 pt status-bar frame but a 10 pt top safe area, so the web view
///    landed at y = 22 over a black strip (wvFrame [0,22,375,769]).
///    FullBleedWebView keeps it at y = 0.
/// 2. The window controls (close / minimise / tile) sit in the top-leading
///    corner, below the top safe area, over the portal header's title. The page
///    cannot see them, so the top safe area grows to clear them (the iPadOS 26
///    corner-adapted safe area) and env(safe-area-inset-top) carries that to
///    the header, the iPad sidebar and the sheets. Full screen and iPhone have
///    no controls there: the extra is 0 and nothing changes.
class VagtplanBridgeViewController: CAPBridgeViewController {
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        return FullBleedWebView(frame: frame, configuration: configuration)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        clearWindowControls()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        clearWindowControls()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.clearWindowControls()
        }
    }

    /// Extra top inset so the page's top safe area ends below the window
    /// controls. Read from the WINDOW, whose safe area this controller's
    /// additionalSafeAreaInsets never touches, so the value cannot feed back
    /// into itself.
    private func clearWindowControls() {
        guard #available(iOS 26.0, *), let window = view.window else { return }
        let plain = window.safeAreaInsets.top
        let cleared = window.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top
        let extra = max(0, (cleared - plain).rounded(.up))
        if additionalSafeAreaInsets.top != extra {
            additionalSafeAreaInsets.top = extra
        }
    }
}

/// The bridge's root view. It always starts at the top of the window: a frame
/// pushed down (the StatusBar plugin's resize above) is put back at y = 0 with
/// the height it was cut by, so no strip of window shows above the page.
final class FullBleedWebView: WKWebView {
    override var frame: CGRect {
        get { return super.frame }
        set {
            var pinned = newValue
            if pinned.origin.y > 0 {
                pinned.size.height += pinned.origin.y
                pinned.origin.y = 0
            }
            super.frame = pinned
        }
    }
}
