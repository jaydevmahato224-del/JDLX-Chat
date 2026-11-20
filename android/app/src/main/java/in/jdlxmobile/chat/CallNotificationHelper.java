package in.jdlxmobile.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Builds the native incoming-call notification and performs the actions that
 * must work while the WebView is not running (answer / decline).
 */
public final class CallNotificationHelper {

    public static final String CHANNEL_SILENT = "incoming_call_native";
    public static final String CHANNEL_ALERT = "incoming_call_native_alert";
    public static final String TAG = "jdlx_call";
    public static final int NOTIFICATION_ID = 7001;

    public static final String ACTION_ANSWER = "in.jdlxmobile.chat.CALL_ANSWER";
    public static final String ACTION_DECLINE = "in.jdlxmobile.chat.CALL_DECLINE";
    public static final String ACTION_DISMISS = "in.jdlxmobile.chat.CALL_DISMISS";

    public static final String EXTRA_CALL_ID = "call_id";
    public static final String EXTRA_ROOM_ID = "room_id";
    public static final String EXTRA_CALL_TYPE = "call_type";
    public static final String EXTRA_CALLER_NAME = "caller_name";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    public static final String PREFS = "jdlx_call_native";
    public static final String PREF_TOKEN = "chat_token";
    public static final String PREF_API_BASE = "api_base";
    public static final String DEFAULT_API_BASE = "https://jdlx-chat-production.up.railway.app/api";

    private static final long RING_TIMEOUT_MS = 60_000L;

    private CallNotificationHelper() { }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean canUseFullScreenIntent(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.canUseFullScreenIntent();
    }

    private static void ensureChannel(Context context, String channelId, boolean silent) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(channelId) != null) return;

        NotificationChannel channel = new NotificationChannel(
            channelId,
            silent ? "Incoming calls" : "Incoming call alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Voice and video call alerts");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 1000, 1000});
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        if (silent) {
            // The full-screen activity plays the looping ringtone itself.
            channel.setSound(null, null);
        } else {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ringtone != null) channel.setSound(ringtone, attributes);
        }
        manager.createNotificationChannel(channel);
    }

    private static Bundle bundleFrom(Map<String, String> data) {
        Bundle extras = new Bundle();
        if (data == null) return extras;
        for (Map.Entry<String, String> entry : data.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                extras.putString(entry.getKey(), entry.getValue());
            }
        }
        return extras;
    }

    public static void showIncomingCall(Context context, Map<String, String> data) {
        Bundle extras = bundleFrom(data);
        String callId = extras.getString(EXTRA_CALL_ID, "");
        String callType = extras.getString(EXTRA_CALL_TYPE, "voice");
        boolean video = "video".equalsIgnoreCase(callType);
        String callerName = extras.getString(EXTRA_CALLER_NAME, "Someone");
        String title = extras.getString(EXTRA_TITLE, video ? "Incoming video call" : "Incoming voice call");
        String body = extras.getString(EXTRA_BODY, callerName + " is calling…");

        boolean fullScreenAllowed = canUseFullScreenIntent(context);
        String channelId = fullScreenAllowed ? CHANNEL_SILENT : CHANNEL_ALERT;
        ensureChannel(context, channelId, fullScreenAllowed);

        Intent fullIntent = new Intent(context, IncomingCallActivity.class);
        fullIntent.putExtras(extras);
        fullIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent fullPending = PendingIntent.getActivity(
            context,
            100,
            fullIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Answer must open the app directly. Sending it through a
        // BroadcastReceiver first is a notification trampoline, which Android
        // 12+ blocks for background activity starts.
        Intent answerIntent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("jdlxchat://call/" + Uri.encode(callId) + "?action=answer")
        );
        answerIntent.setClass(context, MainActivity.class);
        answerIntent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
        );
        PendingIntent answerPending = PendingIntent.getActivity(
            context,
            101,
            answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent declineIntent = new Intent(context, CallActionReceiver.class);
        declineIntent.setAction(ACTION_DECLINE);
        declineIntent.putExtras(extras);
        PendingIntent declinePending = PendingIntent.getBroadcast(
            context,
            102,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setShowWhen(false)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .setFullScreenIntent(fullPending, true)
            .addAction(0, "Decline", declinePending)
            .addAction(0, "Answer", answerPending);

        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            manager.notify(TAG, NOTIFICATION_ID, builder.build());
        } catch (SecurityException ignored) {
            // Notification permission revoked: nothing else we can do natively.
        }
    }

    public static void cancel(Context context) {
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(TAG, NOTIFICATION_ID);
    }

    private static void sendDismiss(Context context, Bundle extras) {
        Intent dismiss = new Intent(ACTION_DISMISS);
        dismiss.setPackage(context.getPackageName());
        if (extras != null) dismiss.putExtras(extras);
        context.sendBroadcast(dismiss);
    }

    public static void launchAnswer(Context context, Bundle extras) {
        cancel(context);
        sendDismiss(context, extras);
        launchDeepLink(context, extras, "answer");
    }

    public static void decline(Context context, Bundle extras) {
        cancel(context);
        sendDismiss(context, extras);

        final String callId = extras != null ? extras.getString(EXTRA_CALL_ID, "") : "";
        final String roomId = extras != null ? extras.getString(EXTRA_ROOM_ID, "") : "";
        final String token = prefs(context).getString(PREF_TOKEN, "");
        final String apiBase = prefs(context).getString(PREF_API_BASE, DEFAULT_API_BASE);

        if (callId.isEmpty() || roomId.isEmpty() || token.isEmpty()) {
            launchDeepLink(context, extras, "decline");
            return;
        }

        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            boolean ended = false;
            HttpURLConnection connection = null;
            try {
                String base = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
                URL url = new URL(base + "/chat/rooms/" + roomId + "/call/end");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write("{}".getBytes("UTF-8"));
                }
                int code = connection.getResponseCode();
                ended = code >= 200 && code < 300;
            } catch (Exception ignored) {
                // Fall through to opening the app, where JS can refresh the token.
            } finally {
                if (connection != null) connection.disconnect();
            }
            if (!ended) {
                launchDeepLink(appContext, extras, "decline");
            }
        }, "jdlx-call-decline").start();
    }

    private static void launchDeepLink(Context context, Bundle extras, String action) {
        String callId = extras != null ? extras.getString(EXTRA_CALL_ID, "") : "";
        String uri = "jdlxchat://call/" + Uri.encode(callId) + "?action=" + action;
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
        intent.setClass(context, MainActivity.class);
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
        );
        try {
            context.startActivity(intent);
        } catch (Exception ignored) {
            // Android may block background activity starts; the notification
            // remains available for the user to tap.
        }
    }
}
