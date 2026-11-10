package dk.bonbox.scheduler;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Same as the owner app: don't draw behind system bars, so the portal
        // header never sits under the status bar (the iOS staff app also lets
        // the OS own the top inset — contentInset "automatic").
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }
}
