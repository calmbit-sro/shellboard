import type { IMarker } from "@xterm/xterm";

/** Prompt positions (OSC 133;A) per terminal, as xterm markers — they track
 * their line across scrollback trimming and reflow. Session-only; marks are
 * not persisted, so jumping works from the first prompt after a restore. */
const MAX_MARKS = 200;

const marks = new Map<string, IMarker[]>();

export function addPromptMark(terminalId: string, marker: IMarker): void {
  let list = marks.get(terminalId);
  if (!list) {
    list = [];
    marks.set(terminalId, list);
  }
  list.push(marker);
  while (list.length > MAX_MARKS) list.shift()?.dispose();
}

export function clearPromptMarks(terminalId: string): void {
  const list = marks.get(terminalId);
  if (list) for (const m of list) m.dispose();
  marks.delete(terminalId);
}

/** Buffer line of the nearest prompt strictly above (dir -1) or below
 * (dir 1) `fromLine`, or null when there is none. */
export function nearestPromptLine(
  terminalId: string,
  fromLine: number,
  dir: -1 | 1,
): number | null {
  const list = marks.get(terminalId);
  if (!list) return null;
  const lines = list.filter((m) => !m.isDisposed).map((m) => m.line);
  if (dir === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] < fromLine) return lines[i];
    }
  } else {
    for (const line of lines) {
      if (line > fromLine) return line;
    }
  }
  return null;
}
