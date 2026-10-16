// App-wide lifecycle across windows. Every window (main + scratch) has its own
// JS realm and store, so quitting from any one of them has to ask the others
// to flush their session state before the process exits, and settings saved in
// one window have to be pushed into the others' stores.

import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  flushSessionSave,
  useAppStore,
  type Settings,
} from "../store/appStore";

const QUIT_FLUSH = "app://quit-flush";
const QUIT_FLUSH_ACK = "app://quit-flush-ack";
/** Scratch → main: "the user confirmed a quit here; run it from main". */
const QUIT_REQUEST = "app://quit-request";
const MAIN_LABEL = "main";
const SETTINGS_CHANGED = "settings://changed";
/** Upper bound on waiting for other windows to ack their flush. */
const ACK_TIMEOUT_MS = 2000;
/** A window that only received a flush request clears its quitting flag after
 *  this long if the process is still alive (the quitter's exit failed), so a
 *  later deliberate close of a scratch window still discards it. */
const QUIT_FLAG_FALLBACK_MS = 5000;

type QuitFlushPayload = { requestId: string };
type QuitFlushAckPayload = { requestId: string; label: string };
type SettingsChangedPayload = { from: string; settings: Settings };

let quitting = false;
let quittingResetTimer: ReturnType<typeof setTimeout> | null = null;
/** requestIds this window broadcast itself — its own flush listener ignores
 *  them (global emits reach the emitter's listeners too). */
const ownRequestIds = new Set<string>();

/** Set `quitting`, clearing it again after QUIT_FLAG_FALLBACK_MS unless the
 *  process exits first. Used where this window doesn't drive the exit. */
function markQuittingWithFallback(): void {
  quitting = true;
  if (quittingResetTimer) clearTimeout(quittingResetTimer);
  quittingResetTimer = setTimeout(() => {
    quittingResetTimer = null;
    quitting = false;
  }, QUIT_FLAG_FALLBACK_MS);
}

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

/** Quit the whole app. From the main window this runs the quit directly; a
 *  scratch window (whose confirm dialog, if any, already ran there) hands the
 *  quit to main so main's own — potentially heavy — flush isn't bounded by the
 *  ack timeout. Falls back to quitting locally if the hand-off can't be sent. */
export async function quitApp(): Promise<void> {
  if (ownLabel() !== MAIN_LABEL) {
    try {
      await emitTo(MAIN_LABEL, QUIT_REQUEST, {});
      // Main will broadcast the flush request; until then (or if main never
      // acts) behave as quitting, with the same fallback reset.
      markQuittingWithFallback();
      return;
    } catch (e) {
      console.error("quit hand-off to main failed, quitting locally:", e);
    }
  }
  await runQuit();
}

/** Ask every other window to flush, flush this one concurrently with waiting
 *  for their acks (≤ ACK_TIMEOUT_MS; this window's own flush is unbounded),
 *  then exit the process. */
async function runQuit(): Promise<void> {
  if (quittingResetTimer) {
    clearTimeout(quittingResetTimer);
    quittingResetTimer = null;
  }
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
    ownRequestIds.add(requestId);
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
  try {
    await invoke("exit_app");
  } catch (e) {
    // Still alive: let the user retry and let closes behave normally again.
    console.error("exit_app failed:", e);
    quitting = false;
  }
}

/** Wire the cross-window listeners for this window. Returns a cleanup. */
export function installLifecycleListeners(): () => void {
  const me = ownLabel();
  const unlistens: Promise<UnlistenFn>[] = [
    listen<QuitFlushPayload>(QUIT_FLUSH, (e) => {
      const requestId = e.payload?.requestId;
      if (typeof requestId !== "string") return;
      if (ownRequestIds.has(requestId)) return;
      markQuittingWithFallback();
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
  if (me === MAIN_LABEL) {
    // A scratch window confirmed a quit and handed it off. Ignore it while
    // this window is already quitting.
    unlistens.push(
      listen(QUIT_REQUEST, () => {
        if (quitting) return;
        void runQuit();
      }),
    );
  }
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
