import { load, type Store } from "@tauri-apps/plugin-store";
import type { PersistedSession } from "./sessionSerialize";

const CONFIG_FILE = "shellboard.json";
const SESSION_FILE = "session.json";
// Scrollback snapshots live in their own file. They can be huge and
// fully regenerable, so isolating them from tabs/projects state keeps
// the main session.json small and human-inspectable, and a corrupted
// buffers file never takes the layout down with it.
const BUFFERS_FILE = "buffers.json";

const KEY_PROJECTS = "projects";
const KEY_GROUPS = "groups";
const KEY_SIDEBAR_WIDTH = "sidebarWidth";
const KEY_SIDEBAR_VISIBLE = "sidebarVisible";
const KEY_SETTINGS = "settings";
const KEY_SESSION = "session";
const KEY_BUFFERS = "buffers";

let cachedConfig: Promise<Store> | null = null;
let cachedSession: Promise<Store> | null = null;
let cachedBuffers: Promise<Store> | null = null;

function getConfigStore(): Promise<Store> {
  if (!cachedConfig) {
    cachedConfig = load(CONFIG_FILE, { autoSave: false, defaults: {} });
  }
  return cachedConfig;
}

function getSessionStore(): Promise<Store> {
  if (!cachedSession) {
    cachedSession = load(SESSION_FILE, { autoSave: false, defaults: {} });
  }
  return cachedSession;
}

function getBuffersStore(): Promise<Store> {
  if (!cachedBuffers) {
    cachedBuffers = load(BUFFERS_FILE, { autoSave: false, defaults: {} });
  }
  return cachedBuffers;
}

export async function loadPersisted<T>(
  key:
    | typeof KEY_PROJECTS
    | typeof KEY_GROUPS
    | typeof KEY_SIDEBAR_WIDTH
    | typeof KEY_SIDEBAR_VISIBLE
    | typeof KEY_SETTINGS,
): Promise<T | null> {
  const store = await getConfigStore();
  const value = await store.get<T>(key);
  return value ?? null;
}

async function setAndSave(
  store: Store,
  key: string,
  value: unknown,
): Promise<void> {
  await store.set(key, value);
  await store.save();
}

export async function saveProjects<T>(projects: T): Promise<void> {
  const store = await getConfigStore();
  await setAndSave(store, KEY_PROJECTS, projects);
}

export async function saveGroups<T>(groups: T): Promise<void> {
  const store = await getConfigStore();
  await setAndSave(store, KEY_GROUPS, groups);
}

export async function saveSidebarWidth(width: number): Promise<void> {
  const store = await getConfigStore();
  await setAndSave(store, KEY_SIDEBAR_WIDTH, width);
}

export async function saveSidebarVisible(visible: boolean): Promise<void> {
  const store = await getConfigStore();
  await setAndSave(store, KEY_SIDEBAR_VISIBLE, visible);
}

export async function saveSettings<T>(settings: T): Promise<void> {
  const store = await getConfigStore();
  await setAndSave(store, KEY_SETTINGS, settings);
}

export async function loadSession(): Promise<PersistedSession | null> {
  const store = await getSessionStore();
  const value = await store.get<PersistedSession>(KEY_SESSION);
  return value ?? null;
}

export async function saveSession(session: PersistedSession): Promise<void> {
  const store = await getSessionStore();
  await setAndSave(store, KEY_SESSION, session);
}

export async function loadBuffers(): Promise<Record<string, string>> {
  const store = await getBuffersStore();
  const value = await store.get<Record<string, string>>(KEY_BUFFERS);
  return value ?? {};
}

export async function saveBuffers(
  buffers: Record<string, string>,
): Promise<void> {
  const store = await getBuffersStore();
  await setAndSave(store, KEY_BUFFERS, buffers);
}

export const PersistenceKeys = {
  projects: KEY_PROJECTS,
  groups: KEY_GROUPS,
  sidebarWidth: KEY_SIDEBAR_WIDTH,
  sidebarVisible: KEY_SIDEBAR_VISIBLE,
  settings: KEY_SETTINGS,
} as const;
