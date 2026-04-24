import { useAppStore } from "../store/appStore";
import { MosaicTab } from "./MosaicTab";

export function TerminalHost() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);

  return (
    <div className="terminal-host">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`terminal-host__slot ${
              isActive ? "terminal-host__slot--active" : ""
            }`}
          >
            <MosaicTab tabId={tab.id} isActiveTab={isActive} />
          </div>
        );
      })}
    </div>
  );
}
