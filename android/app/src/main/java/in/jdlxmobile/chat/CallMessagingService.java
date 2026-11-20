package in.jdlxmobile.chat;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Replaces Capacitor's messaging service in the manifest (same intent filter)
 * and extends it, so normal chat messages keep their existing notification
 * behaviour while incoming-call data messages get the native full-screen UI.
 *
 * Call pushes are data-only on purpose: a notification payload would be shown
 * by Android itself in the background and this service would never run.
 */
public class CallMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data != null && "incoming_call".equals(data.get("type"))) {
            if (AppVisibility.isForeground()) {
                // The WebView is visible and its call watcher owns the ringing
                // modal; forward so JS sees the event instead of stacking a
                // native full-screen activity on top of it.
                super.onMessageReceived(remoteMessage);
                return;
            }
            CallNotificationHelper.showIncomingCall(getApplicationContext(), data);
            return;
        }
        super.onMessageReceived(remoteMessage);
    }
}
