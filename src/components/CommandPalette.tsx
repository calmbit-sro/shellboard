import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import { openPath } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store/appStore";
import { THEMES } from "../utils/themes";
import "./CommandPalette.css";

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onAddProject: () => void;
  onOpenAbout: () => void;
  onOpenGlobalSearch: () => void;
  onOpenShortcuts: () => void;
};

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
  onAddProject,
  onOpenAbout,
  onOpenGlobalSearch,
  onOpenShortcuts,
}: CommandPaletteProps) {
  const projects = useAppStore((s) => s.projects);
  const groups = useAppStore((s) => s.groups);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const currentTheme = useAppStore((s) => s.settings.terminalTheme);
  const autoCwd = useAppStore((s) => s.settings.autoCwdTracking);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const tabs = useAppStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const listRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape is handled internally by cmdk; also close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (listRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    window.addEventListener("mousedown", onDown, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  function run(fn: () => void | Promise<void>) {
    return () => {
      onClose();
      void fn();
    };
  }

  const store = useAppStore.getState();

  return (
    <div className="palette-backdrop">
      <div ref={listRef} className="palette">
        <Command label="Command palette" loop>
          <Command.Input
            autoFocus
            placeholder="Type a command…"
            className="palette__input"
          />
          <Command.List className="palette__list">
            <Command.Empty className="palette__empty">
              No matching commands.
            </Command.Empty>

            <Command.Group heading="Projects" className="palette__group">
              <Command.Item
                value="add new project"
                onSelect={run(() => onAddProject())}
                className="palette__item"
              >
                Add new project…
              </Command.Item>
              {activeProject && (
                <>
                  <Command.Item
                    value={`rename project ${activeProject.name}`}
                    onSelect={run(() =>
                      store.requestProjectRename(activeProject.id),
                    )}
                    className="palette__item"
                  >
                    Rename current project
                  </Command.Item>
                  <Command.Item
                    value={`open in finder explorer ${activeProject.name} ${activeProject.path}`}
                    onSelect={run(async () => {
                      try {
                        await openPath(activeProject.path);
                      } catch {
                        /* ignore */
                      }
                    })}
                    className="palette__item"
                  >
                    Open current project in file explorer
                  </Command.Item>
                </>
              )}
              {projects.map((p) => (
                <Command.Item
                  key={`project-${p.id}`}
                  value={`project ${p.name} ${p.path}`}
                  onSelect={run(() => store.openProject(p.id))}
                  className="palette__item"
                >
                  <span
                    className="palette__dot"
                    style={{ background: p.color }}
                  />
                  <span className="palette__label">
                    Switch to {p.name}
                  </span>
                  {p.id === activeProjectId && (
                    <span className="palette__hint">active</span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>

            {projects.some((p) => (p.snippets?.length ?? 0) > 0) && (
              <Command.Group heading="Snippets" className="palette__group">
                {projects.flatMap((p) =>
                  (p.snippets ?? []).map((s) => (
                    <Command.Item
                      key={`snippet-${p.id}-${s.id}`}
                      value={`snippet ${p.name} ${s.name} ${s.command}`}
                      onSelect={run(() => store.runSnippet(p.id, s.id))}
                      className="palette__item"
                    >
                      <span
                        className="palette__dot"
                        style={{ background: p.color }}
                      />
                      <span className="palette__label">
                        {p.name} · {s.name || s.command}
                      </span>
                    </Command.Item>
                  )),
                )}
              </Command.Group>
            )}

            <Command.Group heading="Groups" className="palette__group">
              <Command.Item
                value="new group"
                onSelect={run(async () => {
                  const g = await store.addGroup("New group");
                  store.requestGroupRename(g.id);
                })}
                className="palette__item"
              >
                New group…
              </Command.Item>
              {groups.map((g) => (
                <Command.Item
                  key={`rename-group-${g.id}`}
                  value={`rename group ${g.name}`}
                  onSelect={run(() => store.requestGroupRename(g.id))}
                  className="palette__item"
                >
                  Rename group: {g.name}
                </Command.Item>
              ))}
              {groups.map((g) => (
                <Command.Item
                  key={`remove-group-${g.id}`}
                  value={`remove group ${g.name}`}
                  onSelect={run(() => store.removeGroup(g.id))}
                  className="palette__item"
                >
                  Remove group: {g.name}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Tabs" className="palette__group">
              <Command.Item
                value="new tab"
                onSelect={run(() => store.addTab())}
                className="palette__item"
              >
                New tab
                <span className="palette__hint">⌘T</span>
              </Command.Item>
              {activeTabId && (
                <>
                  <Command.Item
                    value="rename tab"
                    onSelect={run(() => store.requestTabRename(activeTabId))}
                    className="palette__item"
                  >
                    Rename current tab
                  </Command.Item>
                  <Command.Item
                    value="broadcast input toggle fanout"
                    onSelect={run(() => store.toggleBroadcast(activeTabId))}
                    className="palette__item"
                  >
                    {activeTab?.broadcastInput ? "Disable" : "Enable"}{" "}
                    broadcast input
                  </Command.Item>
                  <Command.Item
                    value="close tab"
                    onSelect={run(() => store.closeTab(activeTabId))}
                    className="palette__item"
                  >
                    Close tab
                    <span className="palette__hint">⌘W</span>
                  </Command.Item>
                </>
              )}
              <Command.Item
                value="close panel"
                onSelect={run(() => store.closeActivePanel())}
                className="palette__item"
              >
                Close panel
                <span className="palette__hint">⌘⇧W</span>
              </Command.Item>
              <Command.Item
                value="next tab"
                onSelect={run(() => store.nextTab())}
                className="palette__item"
              >
                Next tab
                <span className="palette__hint">⌃Tab</span>
              </Command.Item>
              <Command.Item
                value="previous tab"
                onSelect={run(() => store.prevTab())}
                className="palette__item"
              >
                Previous tab
                <span className="palette__hint">⌃⇧Tab</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Split" className="palette__group">
              <Command.Item
                value="split right vertical"
                onSelect={run(() => store.splitActiveTerminal("row"))}
                className="palette__item"
              >
                Split right
                <span className="palette__hint">⌘D</span>
              </Command.Item>
              <Command.Item
                value="split down horizontal"
                onSelect={run(() => store.splitActiveTerminal("column"))}
                className="palette__item"
              >
                Split down
                <span className="palette__hint">⌘⇧D</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Focus" className="palette__group">
              <Command.Item
                value="focus left"
                onSelect={run(() => store.moveFocus("left"))}
                className="palette__item"
              >
                Focus left panel
              </Command.Item>
              <Command.Item
                value="focus right"
                onSelect={run(() => store.moveFocus("right"))}
                className="palette__item"
              >
                Focus right panel
              </Command.Item>
              <Command.Item
                value="focus up"
                onSelect={run(() => store.moveFocus("up"))}
                className="palette__item"
              >
                Focus up panel
              </Command.Item>
              <Command.Item
                value="focus down"
                onSelect={run(() => store.moveFocus("down"))}
                className="palette__item"
              >
                Focus down panel
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Theme" className="palette__group">
              {THEMES.map((t) => (
                <Command.Item
                  key={`theme-${t.id}`}
                  value={`theme ${t.name}`}
                  onSelect={run(() =>
                    store.updateSettings({ terminalTheme: t.id }),
                  )}
                  className="palette__item"
                >
                  <span
                    className="palette__dot"
                    style={{ background: t.theme.background ?? "#1e1e1e" }}
                  />
                  <span className="palette__label">Theme: {t.name}</span>
                  {t.id === currentTheme && (
                    <span className="palette__hint">current</span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Settings" className="palette__group">
              <Command.Item
                value="open settings preferences"
                onSelect={run(() => onOpenSettings())}
                className="palette__item"
              >
                Open settings…
                <span className="palette__hint">⌘,</span>
              </Command.Item>
              <Command.Item
                value="toggle cwd tracking osc7"
                onSelect={run(() =>
                  store.updateSettings({ autoCwdTracking: !autoCwd }),
                )}
                className="palette__item"
              >
                {autoCwd ? "Disable" : "Enable"} directory tracking
              </Command.Item>
              <Command.Item
                value="toggle sidebar"
                onSelect={run(() => store.toggleSidebar())}
                className="palette__item"
              >
                {sidebarVisible ? "Hide" : "Show"} sidebar
                <span className="palette__hint">⌘B</span>
              </Command.Item>
              <Command.Item
                value="global search buffers"
                onSelect={run(() => onOpenGlobalSearch())}
                className="palette__item"
              >
                Search across all terminals…
                <span className="palette__hint">⌘⇧F</span>
              </Command.Item>
              <Command.Item
                value="keyboard shortcuts help cheat sheet"
                onSelect={run(() => onOpenShortcuts())}
                className="palette__item"
              >
                Keyboard shortcuts
                <span className="palette__hint">?</span>
              </Command.Item>
              <Command.Item
                value="about shellboard info version"
                onSelect={run(() => onOpenAbout())}
                className="palette__item"
              >
                About Shellboard
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
