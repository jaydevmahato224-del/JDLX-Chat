package in.jdlxmobile.chat;

import android.app.Activity;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Voice/video call audio routing for the WebView.
 *
 * Switches output between the loudspeaker ("loud"), earpiece ("ear"), and an
 * attached wired or Bluetooth headset ("headset") when present. Also manages
 * call audio focus, volume stream, and the proximity screen-off lock while in
 * earpiece ("ear") mode so cheek touches cannot hang up or mute a call.
 */
@CapacitorPlugin(name = "CallAudio")
public class CallAudioPlugin extends Plugin {

    private static final long ROUTE_RESYNC_DELAY_MS = 350L;
    private static final String ROUTE_LOUD = "loud";
    private static final String ROUTE_EAR = "ear";
    private static final String ROUTE_HEADSET = "headset";

    private AudioManager audioManager;
    private PowerManager powerManager;
    private PowerManager.WakeLock proximityWakeLock;
    private AudioManager.OnAudioFocusChangeListener focusListener;
    private AudioFocusRequest audioFocusRequest;
    private AudioDeviceCallback audioDeviceCallback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingRouteSync;
    private boolean callActive = false;
    private boolean currentCallIsVideo = false;
    private boolean scoStarted = false;
    private String preferredRoute = ROUTE_LOUD;

    @Override
    public void load() {
        Context context = getContext();
        audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        // No-op listener: the OS call volume/mode is what matters here.
        focusListener = focusChange -> { };
        registerDeviceCallback();
    }

    private void runOnMainThread(Runnable task) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(task);
        } else {
            mainHandler.post(task);
        }
    }

    private void cancelPendingRouteSync() {
        if (pendingRouteSync != null) {
            mainHandler.removeCallbacks(pendingRouteSync);
            pendingRouteSync = null;
        }
    }

    private void scheduleRouteSync() {
        cancelPendingRouteSync();
        pendingRouteSync = () -> {
            pendingRouteSync = null;
            if (callActive && audioManager != null) {
                applyAudioRoute(preferredRoute);
                updateProximityLock();
            }
        };
        mainHandler.postDelayed(pendingRouteSync, ROUTE_RESYNC_DELAY_MS);
    }

    private void registerDeviceCallback() {
        if (audioManager == null || audioDeviceCallback != null) return;
        audioDeviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                handleAudioDevicesChanged();
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                handleAudioDevicesChanged();
            }
        };
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler);
    }

    private void unregisterDeviceCallback() {
        if (audioManager != null && audioDeviceCallback != null) {
            try {
                audioManager.unregisterAudioDeviceCallback(audioDeviceCallback);
            } catch (Exception ignored) { }
            audioDeviceCallback = null;
        }
    }

    private void handleAudioDevicesChanged() {
        if (audioManager == null) return;
        String headsetType = detectConnectedHeadsetType();
        if (callActive && ROUTE_HEADSET.equals(preferredRoute) && headsetType == null) {
            // Headset disconnected mid-call: fall back to ear on voice calls for
            // privacy, or loud on video calls, and re-apply cleanly.
            preferredRoute = currentCallIsVideo ? ROUTE_LOUD : ROUTE_EAR;
            applyAudioRoute(preferredRoute);
        }
        updateProximityLock();
        notifyListeners("audioRoutesChanged", buildAudioStatePayload());
    }

    private String normalizeRoute(String mode) {
        if (ROUTE_EAR.equalsIgnoreCase(mode)) return ROUTE_EAR;
        if (ROUTE_HEADSET.equalsIgnoreCase(mode)) return ROUTE_HEADSET;
        return ROUTE_LOUD;
    }

    private String resolveRequestedRoute(PluginCall call, String fallback) {
        String mode = call.getString("mode");
        if (mode != null && !mode.isEmpty()) {
            return normalizeRoute(mode);
        }
        Boolean speaker = call.getBoolean("speaker");
        if (speaker != null) return speaker ? ROUTE_LOUD : ROUTE_EAR;
        Boolean enabled = call.getBoolean("enabled");
        if (enabled != null) return enabled ? ROUTE_LOUD : ROUTE_EAR;
        return fallback;
    }

    private boolean isBluetoothHeadsetDevice(AudioDeviceInfo device) {
        int type = device.getType();
        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && type == AudioDeviceInfo.TYPE_HEARING_AID) {
            return true;
        }
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET;
    }

    private boolean isWiredHeadsetDevice(AudioDeviceInfo device) {
        int type = device.getType();
        if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES) {
            return true;
        }
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && type == AudioDeviceInfo.TYPE_USB_HEADSET;
    }

    private String detectConnectedHeadsetType() {
        if (audioManager == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
            for (AudioDeviceInfo device : commDevices) {
                if (isBluetoothHeadsetDevice(device)) return "bluetooth";
            }
            for (AudioDeviceInfo device : commDevices) {
                if (isWiredHeadsetDevice(device)) return "wired";
            }
        }
        AudioDeviceInfo[] outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        for (AudioDeviceInfo device : outputs) {
            if (isBluetoothHeadsetDevice(device)) return "bluetooth";
        }
        for (AudioDeviceInfo device : outputs) {
            if (isWiredHeadsetDevice(device)) return "wired";
        }
        return null;
    }

    private AudioDeviceInfo findCommunicationDeviceByType(int targetType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || audioManager == null) return null;
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo device : devices) {
            if (device.getType() == targetType) return device;
        }
        return null;
    }

    private AudioDeviceInfo findHeadsetCommunicationDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || audioManager == null) return null;
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo device : devices) {
            if (isBluetoothHeadsetDevice(device)) return device;
        }
        for (AudioDeviceInfo device : devices) {
            if (isWiredHeadsetDevice(device)) return device;
        }
        return null;
    }

    private void stopBluetoothScoIfNeeded() {
        if (audioManager == null || !scoStarted) return;
        try {
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
        } catch (Exception ignored) { }
        scoStarted = false;
    }

    private void requestCallAudioFocus() {
        abandonCallAudioFocus();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            audioFocusRequest = new AudioFocusRequest.Builder(
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            )
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(focusListener)
                .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            );
        }
    }

    private void abandonCallAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
            }
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
    }

    private void applyAudioRoute(String route) {
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        String effectiveRoute = normalizeRoute(route);

        if (ROUTE_HEADSET.equals(effectiveRoute) && detectConnectedHeadsetType() == null) {
            effectiveRoute = ROUTE_EAR;
            preferredRoute = ROUTE_EAR;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo targetDevice = null;
            if (ROUTE_LOUD.equals(effectiveRoute)) {
                targetDevice = findCommunicationDeviceByType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            } else if (ROUTE_HEADSET.equals(effectiveRoute)) {
                targetDevice = findHeadsetCommunicationDevice();
            } else {
                targetDevice = findCommunicationDeviceByType(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
            }

            if (targetDevice != null && audioManager.setCommunicationDevice(targetDevice)) {
                return;
            }

            if (ROUTE_LOUD.equals(effectiveRoute)) {
                audioManager.setSpeakerphoneOn(true);
            } else {
                audioManager.clearCommunicationDevice();
                audioManager.setSpeakerphoneOn(false);
            }
            return;
        }

        if (ROUTE_LOUD.equals(effectiveRoute)) {
            stopBluetoothScoIfNeeded();
            audioManager.setSpeakerphoneOn(true);
        } else if (ROUTE_HEADSET.equals(effectiveRoute)) {
            audioManager.setSpeakerphoneOn(false);
            if ("bluetooth".equals(detectConnectedHeadsetType())) {
                try {
                    audioManager.startBluetoothSco();
                    audioManager.setBluetoothScoOn(true);
                    scoStarted = true;
                } catch (Exception ignored) { }
            } else {
                stopBluetoothScoIfNeeded();
            }
        } else {
            stopBluetoothScoIfNeeded();
            audioManager.setSpeakerphoneOn(false);
        }
    }

    private void updateProximityLock() {
        boolean shouldHold = callActive && ROUTE_EAR.equals(preferredRoute);
        if (!shouldHold) {
            releaseProximityLock();
            return;
        }
        if (powerManager == null) return;
        try {
            if (proximityWakeLock == null
                && powerManager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximityWakeLock = powerManager.newWakeLock(
                    PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
                    "jdlxchat:CallProximity"
                );
                proximityWakeLock.setReferenceCounted(false);
            }
            if (proximityWakeLock != null && !proximityWakeLock.isHeld()) {
                proximityWakeLock.acquire();
            }
        } catch (Exception ignored) {
            // Devices without a proximity sensor or restricted power states skip cleanly.
        }
    }

    private void releaseProximityLock() {
        if (proximityWakeLock != null && proximityWakeLock.isHeld()) {
            try {
                proximityWakeLock.release();
            } catch (Exception ignored) { }
        }
    }

    private void setVolumeStream(int streamType) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.setVolumeControlStream(streamType);
        }
    }

    private JSObject buildAudioStatePayload() {
        String headsetType = detectConnectedHeadsetType();
        String activeRoute = normalizeRoute(preferredRoute);
        boolean loud = ROUTE_LOUD.equals(activeRoute);
        JSObject ret = new JSObject();
        ret.put("mode", activeRoute);
        ret.put("enabled", loud);
        ret.put("speakerOn", loud);
        ret.put("hasHeadset", headsetType != null);
        ret.put("headsetType", headsetType != null ? headsetType : "");
        return ret;
    }

    @PluginMethod
    public void getAudioRoutes(PluginCall call) {
        runOnMainThread(() -> call.resolve(buildAudioStatePayload()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        boolean isVideo = Boolean.TRUE.equals(call.getBoolean("video", false));
        String route = resolveRequestedRoute(call, ROUTE_LOUD);

        runOnMainThread(() -> {
            try {
                requestCallAudioFocus();
                currentCallIsVideo = isVideo;
                preferredRoute = route;
                callActive = true;
                setVolumeStream(AudioManager.STREAM_VOICE_CALL);
                applyAudioRoute(route);
                updateProximityLock();
                // WebView WebRTC audio startup can reset the route right after
                // start(); re-assert once so the chosen route sticks.
                scheduleRouteSync();
                call.resolve(buildAudioStatePayload());
            } catch (Exception e) {
                call.reject("Failed to start call audio: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void setSpeakerMode(PluginCall call) {
        updateSpeakerRoute(call);
    }

    @PluginMethod
    public void setSpeakerphoneOn(PluginCall call) {
        updateSpeakerRoute(call);
    }

    private void updateSpeakerRoute(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        String route = resolveRequestedRoute(call, preferredRoute);

        runOnMainThread(() -> {
            try {
                cancelPendingRouteSync();
                if (ROUTE_HEADSET.equals(route) && detectConnectedHeadsetType() == null) {
                    preferredRoute = ROUTE_EAR;
                } else {
                    preferredRoute = route;
                }
                if (callActive) {
                    applyAudioRoute(preferredRoute);
                }
                updateProximityLock();
                call.resolve(buildAudioStatePayload());
            } catch (Exception e) {
                call.reject("Failed to switch audio route: " + e.getMessage());
            }
        });
    }

    private void cleanupAudioState() {
        cancelPendingRouteSync();
        releaseProximityLock();
        stopBluetoothScoIfNeeded();
        if (audioManager == null) {
            callActive = false;
            currentCallIsVideo = false;
            preferredRoute = ROUTE_LOUD;
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice();
        }
        audioManager.setSpeakerphoneOn(false);
        audioManager.setMode(AudioManager.MODE_NORMAL);
        abandonCallAudioFocus();
        setVolumeStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
        callActive = false;
        currentCallIsVideo = false;
        preferredRoute = ROUTE_LOUD;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (audioManager == null) {
            call.reject("Audio manager unavailable");
            return;
        }
        runOnMainThread(() -> {
            try {
                cleanupAudioState();
                call.resolve(new JSObject());
            } catch (Exception e) {
                call.reject("Failed to stop call audio: " + e.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        try {
            unregisterDeviceCallback();
            cleanupAudioState();
        } catch (Exception ignored) {
            // Activity teardown: nothing actionable.
        }
        super.handleOnDestroy();
    }
}
