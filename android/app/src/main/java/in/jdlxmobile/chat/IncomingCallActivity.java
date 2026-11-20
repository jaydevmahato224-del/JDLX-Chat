package in.jdlxmobile.chat;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

/**
 * Native full-screen incoming call UI. Shown over the lock screen while the
 * app is backgrounded or killed, so the callee can answer without waiting for
 * the WebView to boot.
 */
public class IncomingCallActivity extends Activity {

    private static final long RING_TIMEOUT_MS = 60_000L;

    private Bundle extras = new Bundle();
    private MediaPlayer ringtone;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private BroadcastReceiver dismissReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (getIntent() != null && getIntent().getExtras() != null) {
            extras = getIntent().getExtras();
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );
        setVolumeControlStream(AudioManager.STREAM_RING);

        setContentView(buildContentView());
        startRingtone();
        startVibration();
        registerDismissReceiver();

        handler.postDelayed(() -> {
            if (!isFinishing()) {
                CallNotificationHelper.decline(this, extras);
                finish();
            }
        }, RING_TIMEOUT_MS);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private View buildContentView() {
        boolean video = "video".equalsIgnoreCase(extras.getString(CallNotificationHelper.EXTRA_CALL_TYPE, "voice"));
        String callerName = extras.getString(CallNotificationHelper.EXTRA_CALLER_NAME, "Someone");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(28), dp(72), dp(28), dp(44));
        root.setBackgroundColor(Color.rgb(9, 10, 12));

        TextView brand = new TextView(this);
        brand.setText("JDLX Chat");
        brand.setTextColor(Color.rgb(250, 204, 21));
        brand.setTextSize(14);
        brand.setGravity(Gravity.CENTER);
        brand.setLetterSpacing(0.08f);
        root.addView(brand);

        TextView type = new TextView(this);
        type.setText(video ? "Incoming video call" : "Incoming voice call");
        type.setTextColor(Color.rgb(161, 161, 170));
        type.setTextSize(16);
        type.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams typeLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        typeLp.topMargin = dp(18);
        root.addView(type, typeLp);

        TextView name = new TextView(this);
        name.setText(callerName);
        name.setTextColor(Color.WHITE);
        name.setTextSize(32);
        name.setGravity(Gravity.CENTER);
        name.setMaxLines(2);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = dp(10);
        root.addView(name, nameLp);

        TextView hint = new TextView(this);
        hint.setText("Tap Answer to join");
        hint.setTextColor(Color.rgb(113, 113, 122));
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(12);
        root.addView(hint, hintLp);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams buttonsLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        buttonsLp.topMargin = dp(56);
        root.addView(buttons, buttonsLp);

        Button decline = new Button(this);
        decline.setText("Decline");
        decline.setTextColor(Color.WHITE);
        decline.setTextSize(16);
        decline.setAllCaps(false);
        decline.setBackground(buttonBackground(Color.rgb(127, 29, 29)));
        decline.setOnClickListener(v -> {
            CallNotificationHelper.decline(this, extras);
            finish();
        });
        LinearLayout.LayoutParams declineLp = new LinearLayout.LayoutParams(0, dp(58), 1f);
        declineLp.setMargins(dp(6), 0, dp(6), 0);
        buttons.addView(decline, declineLp);

        Button answer = new Button(this);
        answer.setText("Answer");
        answer.setTextColor(Color.rgb(6, 20, 12));
        answer.setTextSize(16);
        answer.setAllCaps(false);
        answer.setBackground(buttonBackground(Color.rgb(34, 197, 94)));
        answer.setOnClickListener(v -> {
            CallNotificationHelper.launchAnswer(this, extras);
            finish();
        });
        LinearLayout.LayoutParams answerLp = new LinearLayout.LayoutParams(0, dp(58), 1f);
        answerLp.setMargins(dp(6), 0, dp(6), 0);
        buttons.addView(answer, answerLp);

        return root;
    }

    private GradientDrawable buttonBackground(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(20));
        return drawable;
    }

    private void startRingtone() {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (uri == null) return;

            ringtone = new MediaPlayer();
            ringtone.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            ringtone.setDataSource(this, uri);
            ringtone.setLooping(true);
            ringtone.prepare();
            ringtone.start();
        } catch (Exception ignored) {
            // Device may have no ringtone or media resources busy.
        }
    }

    private void startVibration() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager =
                    (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (manager != null) vibrator = manager.getDefaultVibrator();
            } else {
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator == null || !vibrator.hasVibrator()) return;

            long[] pattern = new long[]{0, 1000, 1000};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception ignored) {
            // Vibration is best-effort.
        }
    }

    private void stopRingtone() {
        if (ringtone != null) {
            try {
                if (ringtone.isPlaying()) ringtone.stop();
            } catch (Exception ignored) { }
            try {
                ringtone.release();
            } catch (Exception ignored) { }
            ringtone = null;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) { }
            vibrator = null;
        }
    }

    private void registerDismissReceiver() {
        dismissReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!CallNotificationHelper.ACTION_DISMISS.equals(intent.getAction())) return;
                String incomingId = intent.getStringExtra(CallNotificationHelper.EXTRA_CALL_ID);
                String ourId = extras.getString(CallNotificationHelper.EXTRA_CALL_ID);
                if (incomingId == null || ourId == null || incomingId.equals(ourId)) {
                    finish();
                }
            }
        };
        ContextCompat.registerReceiver(
            this,
            dismissReceiver,
            new IntentFilter(CallNotificationHelper.ACTION_DISMISS),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    public void onBackPressed() {
        CallNotificationHelper.decline(this, extras);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopRingtone();
        if (dismissReceiver != null) {
            try {
                unregisterReceiver(dismissReceiver);
            } catch (Exception ignored) { }
            dismissReceiver = null;
        }
        super.onDestroy();
    }
}
