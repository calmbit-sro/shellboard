// App-wide lifecycle across windows. Every window (main + scratch) has its own
// JS realm and store, so quitting from any one of them has to ask the others
// to flush their session state before the process exits, and settings saved in
// one window have to be pushed into the others' stores.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  flushSessionSave,
  useAppStore,
  type Settings,
} from "../store/appStore";

const QUIT_FLUSH = "app://quit-flush";
const QUIT_FLUSH_ACK = "app://quit-flush-ack";
const SETTINGS_CHANGED = "settings://changed";
/** Upper bound on waiting for other windows to ack their flush. */
const ACK_TIMEOUT_MS = 2000;

type QuitFlushPayload = { requestId: string };
type QuitFlushAckPayload = { requestId: string; label: string };
type SettingsChangedPayload = { from: string; settings: Settings };

let quitting = false;

/** True once an app-wide quit has started (in this or another window). A
 *  scratch window's close handler uses it to let the close through without
 *  discarding its state. */
export function isAppQuitting(): boolean {
  return quitting;
}

function ownLabel(): string {
  return getCurrentWebviewWindow().label;
}

async function safeFlush(): Promise<void> {
  try {
    await flushSessionSave();
  } catch {
    /* don't block quit on save failure */
  }
}

/** Resolve once every label in `others` has acked `requestId`, or after
 *  ACK_TIMEOUT_MS — whichever comes first. Never rejects. The listener is
 *  registered once `ready` resolves, so callers must await it (raced
 *  against `done`) before emitting the flush request. */
function collectAcks(
  requestId: string,
  others: string[],
): { ready: Promise<void>; done: Promise<void> } {
  const pending = new Set(others);
  let unlisten: UnlistenFn | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const complete = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    unlisten?.();
    finish();
  };
  if (pending.size === 0) {
    complete();
    return { ready: Promise.resolve(), done };
  }
  timer = setTimeout(complete, ACK_TIMEOUT_MS);
  const ready = listen<QuitFlushAckPayload>(QUIT_FLUSH_ACK, (e) => {
    if (e.payload?.requestId !== requestId) return;
    pending.delete(e.payload.label);
    if (pending.size === 0) complete();
  })
    .then((un) => {
      if (finished) un();
      else unlisten = un;
    })
    .catch(() => {
      // Can't hear acks — fall back to the timeout.
    });
  return { ready, done };
}

/** Quit the whole app: ask every other window to flush, flush this one, wait
 *  for acks (≤ ACK_TIMEOUT_MS), then exit the process. */
export async function quitApp(): Promise<void> {
  quitting = true;
  try {
    const me = ownLabel();
    let others: string[] = [];
    try {
      others = (await invoke<string[]>("window_labels")).filter((l) => l !== me);
    } catch {
      others = [];
    }
    const requestId = crypto.randomUUID();
    const acks = collectAcks(requestId, others);
    // Bounded: if registering the ack listener stalls, the timeout still wins.
    await Promise.race([acks.ready, acks.done]);
    if (others.length > 0) {
      try {
        await emit(QUIT_FLUSH, { requestId } satisfies QuitFlushPayload);
      } catch {
        /* acks will time out */
      }
    }
    await Promise.all([safeFlush(), acks.done]);
  } catch {
    /* fall through to exit regardless */
  }
  await invoke("exit_app");
}

/** Wire the cross-window listeners for this window. Returns a cleanup. */
export function installLifecycleListeners(): () => void {
  const me = ownLabel();
  const unlistens: Promise<UnlistenFn>[] = [
    listen<QuitFlushPayload>(QUIT_FLUSH, (e) => {
      const requestId = e.payload?.requestId;
      if (typeof requestId !== "string") return;
      quitting = true;
      void (async () => {
        await safeFlush();
        try {
          await emit(QUIT_FLUSH_ACK, {
            requestId,
            label: me,
          } satisfies QuitFlushAckPayload);
        } catch {
          /* quitter times out */
        }
      })();
    }),
    listen<SettingsChangedPayload>(SETTINGS_CHANGED, (e) => {
      const p = e.payload;
      if (!p || p.from === me || !p.settings) return;
      useAppStore.getState().applyExternalSettings(p.settings);
    }),
  ];
  return () => {
    for (const u of unlistens) {
      void u.then((un) => un()).catch(() => {});
    }
  };
}

/** Open a new scratch window, optionally starting in `cwd`. */
export async function openScratchWindow(cwd: string | null): Promise<void> {
  try {
    await invoke<string>("open_scratch_window", { id: null, cwd });
  } catch (e) {
    useAppStore
      .getState()
      .showError(`Couldn't open a new window: ${String(e)}`);
  }
}
