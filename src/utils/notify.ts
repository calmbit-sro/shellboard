import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Permission is requested lazily on the first notification attempt and the
// answer cached for the session. Everything is best-effort — notification
// failure must never surface as an app error.
let permitted: boolean | null = null;

export function notifyCommandFinished(title: string, body: string): void {
  void (async () => {
    try {
      if (permitted === null) {
        permitted = await isPermissionGranted();
        if (!permitted) {
          permitted = (await requestPermission()) === "granted";
        }
      }
      if (permitted) sendNotification({ title, body });
    } catch {
      permitted = permitted ?? false;
    }
  })();
}
