package in.jdlxmobile.chat;

/**
 * Tracks whether MainActivity is actually in the foreground.
 *
 * The FCM service uses this to decide between letting the WebView's in-app
 * ringing modal handle a call (app visible) and showing the native full-screen
 * incoming-call screen (app backgrounded or killed).
 */
public final class AppVisibility {

    private static volatile boolean foreground = false;

    private AppVisibility() { }

    public static boolean isForeground() {
        return foreground;
    }

    public static void setForeground(boolean value) {
        foreground = value;
    }
}
