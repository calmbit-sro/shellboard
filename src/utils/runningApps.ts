import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { collectLeaves } from "./mosaic";

// Mirrors the Rust `RunningApp` (serde camelCase).
export type RunningApp = {
  pid: number;
  name: string;
  command: string;
  memoryBytes: number;
};

// Mirrors the Rust `SelfMemory` (serde camelCase).
export type SelfMemory = { appRssBytes: number; terminalCount: number };

// Mirrors the Rust `RunningAppsSnapshot` (serde camelCase).
export type RunningAppsSnapshot = {
  apps: Record<string, RunningApp>;
  selfMemory: SelfMemory;
};

/**
 * Programs running in this window's terminals. The backend snapshot covers
 * every window's sessions, so keep only the leaves of this window's tabs.
 * Rejects when the snapshot call fails — callers decide the fallback.
 */
export async function runningAppsInThisWindow(): Promise<RunningApp[]> {
  const snap = await invoke<RunningAppsSnapshot>("running_apps_snapshot");
  const result: RunningApp[] = [];
  for (const tab of useAppStore.getState().tabs) {
    if (!tab.mosaic) continue;
    for (const leafId of collectLeaves(tab.mosaic)) {
      const app = snap.apps[leafId];
      if (app) result.push(app);
    }
  }
  return result;
}
