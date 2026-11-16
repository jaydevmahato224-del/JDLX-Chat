package in.jdlxmobile.chat;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hardware / system-level screenshot & screen-recording protection.
 *
 * - FLAG_SECURE makes the app invisible to system screenshots, screen
 *   recordings and the Recents/app-switcher preview (captured frames are
 *   black). This is enforced by the OS — nothing can bypass it from inside
 *   the app or from another app.
 * - On Android 14+ the ScreenCaptureCallback additionally reports the moment
 *   the user presses the system screenshot gesture, so the app can surface
 *   its own "screenshot attempt" alert in the chat feed.
 */
@CapacitorPlugin(name = "ScreenProtection")
public class ScreenProtectionPlugin extends Plugin {

    private boolean nativeEnabled = false;
    private Activity.ScreenCaptureCallback screenCaptureCallback;

    @PluginMethod
    public void enable(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity is null");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Activity activity = getActivity();
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                nativeEnabled = true;
                registerCaptureCallback(activity);
                JSObject ret = new JSObject();
                ret.put("enabled", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to enable screen protection: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity is null");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Activity activity = getActivity();
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                nativeEnabled = false;
                unregisterCaptureCallback(activity);
                JSObject ret = new JSObject();
                ret.put("enabled", false);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to disable screen protection: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity is null");
            return;
        }
        boolean isSecure = (getActivity().getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0;
        JSObject ret = new JSObject();
        ret.put("enabled", isSecure);
        call.resolve(ret);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Activity activity = getActivity();
        if (activity != null && nativeEnabled) {
            // Re-assert the secure flag (OEM launchers / older builds can clear
            // window flags when the activity is recreated).
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            registerCaptureCallback(activity);
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        Activity activity = getActivity();
        if (activity != null) {
            unregisterCaptureCallback(activity);
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        Activity activity = getActivity();
        if (activity != null) {
            unregisterCaptureCallback(activity);
        }
    }

    /**
     * Android 14+ (API 34): fires the moment the user takes a screenshot of
     * this activity. With FLAG_SECURE set the frame itself is blocked/black;
     * this callback lets the app still show its "screenshot attempt" alert.
     */
    private void registerCaptureCallback(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return;
        if (screenCaptureCallback != null) return;
        try {
            screenCaptureCallback = () -> {
                JSObject data = new JSObject();
                data.put("at", System.currentTimeMillis());
                notifyListeners("screenCapture", data);
            };
            activity.registerScreenCaptureCallback(
                ContextCompat.getMainExecutor(activity),
                screenCaptureCallback
            );
        } catch (Exception e) {
            screenCaptureCallback = null;
        }
    }

    private void unregisterCaptureCallback(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return;
        if (screenCaptureCallback == null) return;
        try {
            activity.unregisterScreenCaptureCallback(screenCaptureCallback);
        } catch (Exception e) {
            // ignore
        } finally {
            screenCaptureCallback = null;
        }
    }
}
