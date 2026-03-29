package dk.bonbox.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Don't draw behind system bars — prevents content from covering status bar and nav bar
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }
}
