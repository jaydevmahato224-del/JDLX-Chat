package in.jdlxmobile.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Reads phonebook numbers for JDLX Chat friend discovery and launches native
 * SMS / WhatsApp invite composers for contacts who haven't joined yet.
 */
@CapacitorPlugin(
    name = "Contacts",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = ContactsPlugin.ALIAS_CONTACTS)
    }
)
public class ContactsPlugin extends Plugin {

    static final String ALIAS_CONTACTS = "contacts";
    private static final int MAX_UNIQUE_CONTACTS = 2500;

    private JSObject buildPermissionResult() {
        PermissionState state = getPermissionState(ALIAS_CONTACTS);
        String value = state == null ? "prompt" : state.toString();
        JSObject result = new JSObject();
        result.put("state", value);
        result.put("granted", state == PermissionState.GRANTED);
        return result;
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        call.resolve(buildPermissionResult());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState(ALIAS_CONTACTS) == PermissionState.GRANTED) {
            call.resolve(buildPermissionResult());
            return;
        }
        requestPermissionForAlias(ALIAS_CONTACTS, call, "contactsPermissionCallback");
    }

    @PermissionCallback
    private void contactsPermissionCallback(PluginCall call) {
        call.resolve(buildPermissionResult());
    }

    @PluginMethod
    public void getContacts(PluginCall call) {
        if (getPermissionState(ALIAS_CONTACTS) != PermissionState.GRANTED) {
            call.reject("Contacts permission not granted");
            return;
        }

        final ContentResolver resolver = getContext().getContentResolver();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            Map<String, String> deduped = new LinkedHashMap<>();
            Cursor cursor = null;
            try {
                String[] projection = new String[] {
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                };
                cursor = resolver.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    projection,
                    ContactsContract.CommonDataKinds.Phone.NUMBER + " IS NOT NULL",
                    null,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
                );
                if (cursor != null) {
                    int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                    int numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                    while (cursor.moveToNext()) {
                        String rawNumber = numIdx >= 0 ? cursor.getString(numIdx) : null;
                        if (rawNumber == null || rawNumber.trim().isEmpty()) continue;
                        String digits = normalizeKey(rawNumber);
                        if (digits.length() < 10) continue;

                        String name = nameIdx >= 0 ? cursor.getString(nameIdx) : "";
                        String trimmedName = name == null ? "" : name.trim();
                        if (!deduped.containsKey(digits)) {
                            if (deduped.size() >= MAX_UNIQUE_CONTACTS) continue;
                            deduped.put(digits, trimmedName);
                        } else if (deduped.get(digits).isEmpty() && !trimmedName.isEmpty()) {
                            deduped.put(digits, trimmedName);
                        }
                    }
                }

                JSArray list = new JSArray();
                for (Map.Entry<String, String> entry : deduped.entrySet()) {
                    JSObject item = new JSObject();
                    item.put("phone", entry.getKey());
                    item.put("name", entry.getValue());
                    list.put(item);
                }

                JSObject result = new JSObject();
                result.put("contacts", list);
                call.resolve(result);
            } catch (Exception err) {
                call.reject("Unable to read device contacts: " + err.getMessage(), err);
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }
        });
        executor.shutdown();
    }

    @PluginMethod
    public void openSmsInvite(PluginCall call) {
        String rawPhone = call.getString("phone", "");
        String message = call.getString("message", "");
        String cleanDigits = digitsOnly(rawPhone);
        Uri uri = Uri.parse("smsto:" + cleanDigits);

        Intent intent = new Intent(Intent.ACTION_SENDTO, uri);
        intent.putExtra("sms_body", message == null ? "" : message);
        if (launchIntent(intent)) {
            call.resolve();
            return;
        }

        Intent fallback = new Intent(Intent.ACTION_VIEW, Uri.parse("sms:" + cleanDigits));
        fallback.putExtra("sms_body", message == null ? "" : message);
        if (launchIntent(fallback)) {
            call.resolve();
            return;
        }

        call.reject("No SMS app available on this device");
    }

    @PluginMethod
    public void openWhatsAppInvite(PluginCall call) {
        String rawPhone = call.getString("phone", "");
        String message = call.getString("message", "");
        String digits = digitsOnly(rawPhone);
        if (digits.length() == 10) {
            digits = "91" + digits;
        }

        String encodedText = Uri.encode(message == null ? "" : message);
        String url = digits.isEmpty()
            ? "https://wa.me/?text=" + encodedText
            : "https://wa.me/" + digits + "?text=" + encodedText;
        Uri waUri = Uri.parse(url);

        String[] packages = new String[] { "com.whatsapp", "com.whatsapp.w4b" };
        for (String pkg : packages) {
            Intent intent = new Intent(Intent.ACTION_VIEW, waUri);
            intent.setPackage(pkg);
            if (launchIntent(intent)) {
                call.resolve();
                return;
            }
        }

        Intent generic = new Intent(Intent.ACTION_VIEW, waUri);
        if (launchIntent(generic)) {
            call.resolve();
            return;
        }

        call.reject("WhatsApp is not available on this device");
    }

    private boolean launchIntent(Intent intent) {
        try {
            Activity activity = getActivity();
            if (activity != null) {
                activity.startActivity(intent);
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            return true;
        } catch (ActivityNotFoundException err) {
            return false;
        }
    }

    private static String digitsOnly(String raw) {
        if (raw == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= '0' && c <= '9') {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String normalizeKey(String raw) {
        String digits = digitsOnly(raw);
        if (digits.length() > 10) {
            if (digits.startsWith("0091") && digits.length() == 14) {
                digits = digits.substring(4);
            } else if (digits.startsWith("91") && digits.length() == 12) {
                digits = digits.substring(2);
            } else if (digits.startsWith("0") && digits.length() == 11) {
                digits = digits.substring(1);
            }
        }
        return digits;
    }
}
