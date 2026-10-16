import type { Project } from "../store/appStore";

export type WindowContext =
  | { kind: "main" }
  | { kind: "scratch"; id: string; cwd: string | null; restored: boolean };

declare global {
  interface Window {
    /** Injected by the Rust side (initialization script) in scratch windows. */
    __SHELLBOARD_WINDOW__?: unknown;
  }
}

const SCRATCH_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function readWindowContext(): WindowContext {
  try {
    const raw = window.__SHELLBOARD_WINDOW__;
    if (!raw || typeof raw !== "object") return { kind: "main" };
    const r = raw as Record<string, unknown>;
    if (
      r.kind === "scratch" &&
      typeof r.id === "string" &&
      SCRATCH_ID_RE.test(r.id) &&
      (r.cwd === null || typeof r.cwd === "string") &&
      typeof r.restored === "boolean"
    ) {
      return { kind: "scratch", id: r.id, cwd: r.cwd, restored: r.restored };
    }
  } catch {
    // fall through
  }
  return { kind: "main" };
}

export const WINDOW_CONTEXT: WindowContext = readWindowContext();
export const IS_SCRATCH: boolean = WINDOW_CONTEXT.kind === "scratch";

export const SCRATCH_PROJECT_ID = "scratch";

// Slate from PROJECT_COLORS (components/ColorPicker.tsx); duplicated here to
// avoid pulling a component module (and its CSS) into this util.
const SCRATCH_COLOR = "#64748b";

export function scratchProject(path: string): Project {
  return {
    id: SCRATCH_PROJECT_ID,
    name: "Terminal",
    path,
    color: SCRATCH_COLOR,
    createdAt: Date.now(),
    groupId: null,
  };
}
