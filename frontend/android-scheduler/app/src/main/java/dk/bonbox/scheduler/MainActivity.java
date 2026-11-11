package dk.bonbox.scheduler;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * The most the phone's text size may scale the portal's text: one step up.
     * The WebView scales text by the system font size (textZoom = fontScale ×
     * 100); at 150 % "Beskeder" in the dock became "Besked…" and the ring's
     * time touched the ring. Smaller and normal sizes are followed as they are.
     */
    static final int MAX_TEXT_ZOOM = 115;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Same as the owner app: don't draw behind system bars, so the portal
        // header never sits under the status bar (the iOS staff app also lets
        // the OS own the top inset — contentInset "automatic").
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        capTextZoom();
    }

    /**
     * BridgeActivity.onCreate builds the bridge (and its WebView) synchronously,
     * before the page loads, so the zoom is in place for the first paint. A
     * change of the system font size recreates the activity (fontScale is not
     * in configChanges), so this runs again with the new size.
     */
    private void capTextZoom() {
        if (getBridge() == null) return; // no WebView installed: BridgeActivity showed no_webview
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        float fontScale = getResources().getConfiguration().fontScale;
        webView.getSettings().setTextZoom(Math.min(Math.round(fontScale * 100f), MAX_TEXT_ZOOM));
    }
}
