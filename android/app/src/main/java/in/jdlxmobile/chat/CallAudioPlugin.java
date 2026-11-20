package in.jdlxmobile.chat;

import android.content.Context;
import android.media.AudioManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Voice/video call audio routing for the WebView.
 *
 * A browser cannot switch between the loudspeaker and the earpiece, so the
 * in-call speaker button used to be cosmetic in the APK. This plugin puts the
 * device into MODE_IN_COMMUNICATION, takes audio focus (so music/other apps
 * duck or pause) and toggles the speakerphone route. The route follows the UI
 * speaker state (on by default), so the button now actually does something in
 * the APK; no-op on the web where the plugin is absent.
 */
@CapacitorPlugin(name = "CallAudio")
public class CallAudioPlugin extends Plugin {

    private AudioManager audioManager;
    private AudioManager.OnAudioFocusChangeListener focusListener;
    private boolean callActive = false;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        // No-op listener: the OS call volume/mode is what matters here.
        focusListener = focusChange -> { };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        boolean speaker = !Boolean.FALSE.equals(call.getBoolean("speaker", true));

        getActivity().runOnUiThread(() -> {
            try {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.requestAudioFocus(
                    focusListener,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
                );
                // Video calls start on the loudspeaker; voice calls follow the
                // UI (which defaults to speaker on) so both stay predictable.
                audioManager.setSpeakerphoneOn(speaker || video);
                callActive = true;

                JSObject ret = new JSObject();
                ret.put("speakerOn", audioManager.isSpeakerphoneOn());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to start call audio: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void setSpeakerphoneOn(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        boolean enabled = !Boolean.FALSE.equals(call.getBoolean("enabled", true));

        getActivity().runOnUiThread(() -> {
            try {
                if (callActive) {
                    audioManager.setSpeakerphoneOn(enabled);
                }
                JSObject ret = new JSObject();
                ret.put("enabled", audioManager.isSpeakerphoneOn());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to switch audio route: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
                audioManager.abandonAudioFocus(focusListener);
                callActive = false;
                call.resolve(new JSObject());
            } catch (Exception e) {
                call.reject("Failed to stop call audio: " + e.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (audioManager != null) {
            try {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
                audioManager.abandonAudioFocus(focusListener);
            } catch (Exception ignored) {
                // Activity teardown: nothing actionable.
            }
        }
        callActive = false;
        super.handleOnDestroy();
    }
}
