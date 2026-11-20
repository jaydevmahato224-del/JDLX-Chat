package in.jdlxmobile.chat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenProtectionPlugin.class);
        registerPlugin(CallAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
