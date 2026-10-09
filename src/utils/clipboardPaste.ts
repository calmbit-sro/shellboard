import type { Terminal } from "@xterm/xterm";
import {
  readImage as readClipboardImage,
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";

/** Ctrl+V as the PTY sees it. */
const CTRL_V = "\x16";

/**
 * Paste the clipboard into `xterm` (Cmd+V / Ctrl+Shift+V / context menu).
 *
 * Text goes through `xterm.paste` (bracketed paste when the app asked for it).
 * An image-only clipboard has no text to paste, so instead we send Ctrl+V as
 * if typed: that is the key TUIs like Claude Code listen for to read an image
 * straight from the system clipboard — the same thing Ctrl+V does in iTerm2 /
 * Terminal.app. Never rejects.
 */
export async function pasteClipboardInto(xterm: Terminal): Promise<void> {
  const text = await readClipboardText().catch(() => "");
  if (text) {
    xterm.paste(text);
    return;
  }
  try {
    // Only probing for presence; the image lives in a Rust-side resource, so
    // release it right away instead of pulling the pixels over IPC.
    const image = await readClipboardImage();
    void image.close().catch(() => {});
  } catch {
    return; // nothing pasteable on the clipboard
  }
  xterm.input(CTRL_V, true);
}
