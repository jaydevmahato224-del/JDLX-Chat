package in.jdlxmobile.chat;

import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenProtection")
public class ScreenProtectionPlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity is null");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
}
