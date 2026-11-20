package in.jdlxmobile.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * Notification action target. Answer opens the app through the call deep link;
 * Decline ends the call on the backend (with an app fallback if the token is
 * missing or expired).
 */
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        Bundle extras = intent.getExtras();
        String action = intent.getAction();
        if (CallNotificationHelper.ACTION_ANSWER.equals(action)) {
            CallNotificationHelper.launchAnswer(context, extras);
        } else if (CallNotificationHelper.ACTION_DECLINE.equals(action)) {
            CallNotificationHelper.decline(context, extras);
        }
    }
}
