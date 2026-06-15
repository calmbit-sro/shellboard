import { useAppStore } from "../store/appStore";
import { collectLeaves } from "../utils/mosaic";
import { cwdLabel } from "../utils/path";
import "./RecentSwitcher.css";

// The alt-tab overlay for the cross-project recent-terminal switcher. Renders
// only while a switcher session is active (store.switcher non-null). The active
// row tracks store.switcher.index; commit/cancel happen via App's key handlers.
export function RecentSwitcher() {
  const switcher = useAppStore((s) => s.switcher);
  const tabs = useAppStore((s) => s.tabs);
  const projects = useAppStore((s) => s.projects);
  const terminals = useAppStore((s) => s.terminals);

  if (!switcher) return null;

  const rows = switcher.order
    .map((leafId) => {
      const tab = tabs.find(
        (t) => t.mosaic && collectLeaves(t.mosaic).includes(leafId),
      );
      if (!tab) return null;
      const project = projects.find((p) => p.id === tab.projectId);
      if (!project) return null;
      return { leafId, tab, project, cwd: terminals[leafId]?.cwd ?? "" };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (rows.length === 0) return null;

  // switcher.index points into the full `order`; rows may be shorter if a leaf
  // resolution failed, so clamp by leafId rather than position.
  const activeLeafId = switcher.order[switcher.index];

  return (
    <div className="switcher-backdrop">
      <div className="switcher" role="listbox" aria-label="Recent terminals">
        <div className="switcher__title">Recent terminals</div>
        <ul className="switcher__list">
          {rows.map((r) => (
            <li
              key={r.leafId}
              className={
                "switcher__row" +
                (r.leafId === activeLeafId ? " is-active" : "")
              }
              role="option"
              aria-selected={r.leafId === activeLeafId}
            >
              <span
                className="switcher__dot"
                style={{ background: r.project.color }}
              />
              <span className="switcher__label">
                {r.project.name} · {r.tab.title}
              </span>
              {r.cwd && (
                <span className="switcher__cwd">{cwdLabel(r.cwd)}</span>
              )}
            </li>
          ))}
        </ul>
        <div className="switcher__hint">
          Hold · tap to cycle · release to switch
        </div>
      </div>
    </div>
  );
}
