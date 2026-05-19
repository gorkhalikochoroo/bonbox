//
// AppleSignInPlugin.swift
// BonBox — Task #90
//
// Custom Capacitor plugin that wraps Apple's system AuthenticationServices
// framework to provide Sign-In-with-Apple on the native iOS build. We rolled
// our own (instead of pulling @capacitor-community/apple-sign-in) because
// that community plugin pins capacitor-swift-pm ^7 — incompatible with our
// @capacitor/*@8.x. AuthenticationServices is a system framework (no
// SwiftPM dep, no Podfile change), so this approach has zero supply-chain
// risk and stays compatible across Capacitor major versions.
//
// JS bridge: window.Capacitor.Plugins.AppleSignIn.signIn() — returns
//   { identityToken: string, nonce: string, user?: string,
//     givenName?: string, familyName?: string, email?: string }
//
// The shape mirrors what Apple's JS SDK returns for the web flow, so the
// frontend can hand the identityToken straight to POST /api/auth/oauth/apple
// without any extra normalization.
//
// SECURITY: We generate a fresh cryptographic nonce per request, hash it
// with SHA-256, and Apple binds it into the returned id_token. The backend
// (services/oauth_apple.verify_apple_token) is already verifying signature,
// issuer, audience, and expiry — the nonce here is belt-and-braces against
// replay if a token leaks. We hand the *raw* nonce back to JS so the
// backend (or a future audit step) can re-derive the hash and compare.

import Foundation
import Capacitor
import AuthenticationServices
import CryptoKit

@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
    ]

    // Held strong for the duration of the request — ASAuthorizationController
    // does NOT retain its delegate, so without this property the controller
    // dies on the next runloop tick and the user sees nothing.
    private var currentDelegate: AppleSignInDelegate?

    @objc func signIn(_ call: CAPPluginCall) {
        // Generate a cryptographically random nonce and pass the SHA-256
        // hash to Apple. Apple binds the hash into the id_token's `nonce`
        // claim; the raw nonce comes back to JS for any future verification.
        let rawNonce = Self.randomNonceString()
        let hashedNonce = Self.sha256(rawNonce)

        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce

        let controller = ASAuthorizationController(authorizationRequests: [request])
        let delegate = AppleSignInDelegate(call: call, rawNonce: rawNonce) { [weak self] in
            // Release the strong reference once the flow has finished, win
            // or lose, so we don't leak the closure across sign-ins.
            self?.currentDelegate = nil
        }
        self.currentDelegate = delegate
        controller.delegate = delegate
        controller.presentationContextProvider = delegate

        DispatchQueue.main.async {
            controller.performRequests()
        }
    }

    // MARK: - Nonce helpers

    private static func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        // Apple-recommended charset from their SIWA sample code.
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            let randoms: [UInt8] = (0..<16).map { _ in
                var byte: UInt8 = 0
                let status = SecRandomCopyBytes(kSecRandomDefault, 1, &byte)
                if status != errSecSuccess {
                    // Fallback to arc4random — never seen in practice, but
                    // guarantees we don't deadlock on a starved entropy pool.
                    return UInt8.random(in: 0...255)
                }
                return byte
            }
            for r in randoms where remaining > 0 {
                if r < charset.count {
                    result.append(charset[Int(r)])
                    remaining -= 1
                }
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        let data = Data(input.utf8)
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Delegate

private class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let call: CAPPluginCall
    private let rawNonce: String
    private let onFinish: () -> Void

    init(call: CAPPluginCall, rawNonce: String, onFinish: @escaping () -> Void) {
        self.call = call
        self.rawNonce = rawNonce
        self.onFinish = onFinish
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { onFinish() }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            call.reject("no_identity_token", "Apple did not return an identity token")
            return
        }
        var result: [String: Any] = [
            "identityToken": identityToken,
            "nonce": rawNonce,
            "user": credential.user
        ]
        // Apple only sends fullName / email on the FIRST sign-in for a
        // given Apple ID. The backend stashes them on the user row when
        // present and ignores them on repeat sign-ins (the `sub` claim in
        // the id_token is the stable identifier).
        if let given = credential.fullName?.givenName { result["givenName"] = given }
        if let family = credential.fullName?.familyName { result["familyName"] = family }
        if let email = credential.email { result["email"] = email }
        call.resolve(result)
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        defer { onFinish() }
        let nsError = error as NSError
        // ASAuthorizationError.canceled = 1001 — the user explicitly
        // tapped Cancel. We surface a stable string code so the JS side
        // can swallow it silently (parity with the web AppleSignInButton's
        // popup_closed_by_user handling).
        if nsError.domain == ASAuthorizationError.errorDomain,
           nsError.code == ASAuthorizationError.canceled.rawValue {
            call.reject("user_cancelled", "User cancelled Apple sign-in", error)
            return
        }
        call.reject("apple_signin_failed", nsError.localizedDescription, error)
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
