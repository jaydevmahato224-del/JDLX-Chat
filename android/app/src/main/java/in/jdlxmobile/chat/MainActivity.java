package in.jdlxmobile.chat;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenProtectionPlugin.class);
        registerPlugin(CallAudioPlugin.class);
        registerPlugin(CallBridgePlugin.class);
        registerPlugin(AppPermissionsPlugin.class);
        registerPlugin(ContactsPlugin.class);
        super.onCreate(savedInstanceState);
        dismissCallNotification(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
        dismissCallNotification(intent);
    }

    /** Answering/declining via the notification opens this activity directly. */
    private void dismissCallNotification(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        if (!"jdlxchat".equals(data.getScheme()) || !"call".equals(data.getHost())) return;
        CallNotificationHelper.cancel(this);
        Intent dismiss = new Intent(CallNotificationHelper.ACTION_DISMISS);
        dismiss.setPackage(getPackageName());
        sendBroadcast(dismiss);
    }

    @Override
    public void onResume() {
        super.onResume();
        AppVisibility.setForeground(true);
    }

    @Override
    public void onPause() {
        AppVisibility.setForeground(false);
        super.onPause();
    }
}
