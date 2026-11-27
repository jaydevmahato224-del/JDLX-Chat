package in.jdlxmobile.chat;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Coordinates runtime Android permissions (Contacts, Mic, Camera, Notifications)
 * from a single place on app open and from the in-app Permissions/Contacts UI.
 */
@CapacitorPlugin(
    name = "AppPermissions",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = AppPermissionsPlugin.ALIAS_CONTACTS),
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = AppPermissionsPlugin.ALIAS_MICROPHONE),
        @Permission(strings = { Manifest.permission.CAMERA }, alias = AppPermissionsPlugin.ALIAS_CAMERA),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = AppPermissionsPlugin.ALIAS_NOTIFICATIONS)
    }
)
public class AppPermissionsPlugin extends Plugin {

    static final String ALIAS_CONTACTS = "contacts";
    static final String ALIAS_MICROPHONE = "microphone";
    static final String ALIAS_CAMERA = "camera";
    static final String ALIAS_NOTIFICATIONS = "notifications";

    private static final String PREFS_NAME = "jdlx_app_permissions";
    private static final String KEY_ASKED_PREFIX = "asked_";

    private static final String[] STARTUP_ALIASES = new String[] {
        ALIAS_CONTACTS,
        ALIAS_MICROPHONE,
        ALIAS_CAMERA,
        ALIAS_NOTIFICATIONS
    };

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String resolveAliasState(String alias) {
        if (ALIAS_NOTIFICATIONS.equals(alias) && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return "granted";
        }
        PermissionState state = getPermissionState(alias);
        return state == null ? "prompt" : state.toString();
    }

    private boolean isAliasGranted(String alias) {
        if (ALIAS_NOTIFICATIONS.equals(alias) && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private JSObject buildStatus() {
        JSObject result = new JSObject();
        result.put(ALIAS_CONTACTS, resolveAliasState(ALIAS_CONTACTS));
        result.put(ALIAS_MICROPHONE, resolveAliasState(ALIAS_MICROPHONE));
        result.put(ALIAS_CAMERA, resolveAliasState(ALIAS_CAMERA));
        result.put(ALIAS_NOTIFICATIONS, resolveAliasState(ALIAS_NOTIFICATIONS));
        result.put("fullScreenIntent", CallNotificationHelper.canUseFullScreenIntent(getContext()));
        return result;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void requestStartupPermissions(PluginCall call) {
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        SharedPreferences sp = prefs();
        List<String> toRequest = new ArrayList<>();

        for (String alias : STARTUP_ALIASES) {
            if (isAliasGranted(alias)) continue;
            if (force || !sp.getBoolean(KEY_ASKED_PREFIX + alias, false)) {
                toRequest.add(alias);
            }
        }

        if (toRequest.isEmpty()) {
            call.resolve(buildStatus());
            return;
        }

        SharedPreferences.Editor editor = sp.edit();
        for (String alias : toRequest) {
            editor.putBoolean(KEY_ASKED_PREFIX + alias, true);
        }
        editor.apply();

        requestPermissionForAliases(
            toRequest.toArray(new String[0]),
            call,
            "permissionsCallback"
        );
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        String alias = call.getString("alias", "");
        if (!ALIAS_CONTACTS.equals(alias)
            && !ALIAS_MICROPHONE.equals(alias)
            && !ALIAS_CAMERA.equals(alias)
            && !ALIAS_NOTIFICATIONS.equals(alias)) {
            call.reject("Unsupported permission alias: " + alias);
            return;
        }

        if (isAliasGranted(alias)) {
            call.resolve(buildStatus());
            return;
        }

        prefs().edit().putBoolean(KEY_ASKED_PREFIX + alias, true).apply();
        requestPermissionForAlias(alias, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
