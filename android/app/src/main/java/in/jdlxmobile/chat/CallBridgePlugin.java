package in.jdlxmobile.chat;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small bridge between the WebView session and native call handling.
 *
 * The native decline action can run while the WebView is dead, so it needs the
 * current chat token and API base stored natively. The token is refreshed by
 * the app whenever the session changes.
 */
@CapacitorPlugin(name = "CallBridge")
public class CallBridgePlugin extends Plugin {

    @PluginMethod
    public void configure(PluginCall call) {
        String token = call.getString("token", "");
        String apiBaseUrl = call.getString("apiBaseUrl", "");
        SharedPreferences.Editor editor = CallNotificationHelper.prefs(getContext()).edit();
        editor.putString(CallNotificationHelper.PREF_TOKEN, token == null ? "" : token);
        if (apiBaseUrl != null && !apiBaseUrl.isEmpty()) {
            editor.putString(CallNotificationHelper.PREF_API_BASE, apiBaseUrl);
        }
        editor.apply();
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        SharedPreferences.Editor editor = CallNotificationHelper.prefs(getContext()).edit();
        editor.remove(CallNotificationHelper.PREF_TOKEN);
        editor.apply();
        call.resolve();
    }

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", CallNotificationHelper.canUseFullScreenIntent(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName())
            );
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
