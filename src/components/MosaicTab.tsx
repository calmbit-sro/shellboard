import { useCallback, useState } from "react";
import { Mosaic, type MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore, type SplitSide } from "../store/appStore";
import { Terminal } from "./Terminal";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Terminal as TerminalIcon } from "./icons";
import { cwdLabel } from "../utils/path";
import { getTerminal } from "../utils/terminalRegistry";
import "./MosaicTab.css";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

type MosaicTabProps = {
  tabId: string;
  isActiveTab: boolean;
};

type CtxState = { x: number; y: number; leafId: string };

export function MosaicTab({ tabId, isActiveTab }: MosaicTabProps) {
  const tab = useAppStore((s) => s.tabs.find((t) => t.id === tabId));
  const updateMosaic = useAppStore((s) => s.updateMosaic);
  const focusPanel = useAppStore((s) => s.focusPanel);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const closeActivePanel = useAppStore((s) => s.closeActivePanel);

  const [ctx, setCtx] = useState<CtxState | null>(null);

  const onChange = useCallback(
    (node: MosaicNode<string> | null) => {
      updateMosaic(tabId, node);
    },
    [tabId, updateMosaic],
  );

  const renderTile = useCallback(
    (leafId: string) => {
      const isFocused = tab?.focusedLeafId === leafId;
      return (
        <div
          className={`panel ${isFocused ? "panel--focused" : ""}`}
          onMouseDownCapture={() => focusPanel(leafId)}
          onContextMenu={(e) => {
            e.preventDefault();
            focusPanel(leafId);
            setCtx({ x: e.clientX, y: e.clientY, leafId });
          }}
        >
          <PanelHeader leafId={leafId} focused={isFocused} />
          <div className="panel__body">
            <Terminal
              terminalId={leafId}
              isActive={isActiveTab && isFocused}
            />
          </div>
        </div>
      );
    },
    [isActiveTab, tab?.focusedLeafId, focusPanel],
  );

  if (!tab || !tab.mosaic) return null;

  const xtermForCtx = ctx ? getTerminal(ctx.leafId) : undefined;
  const hasSelection = xtermForCtx?.hasSelection() ?? false;
  const copyKbd = IS_MAC ? "⌘C" : "Ctrl+Shift+C";
  const pasteKbd = IS_MAC ? "⌘V" : "Ctrl+Shift+V";

  const menuItems: MenuItem[] = ctx
    ? [
        ...(
          [
            { label: "Split Left", side: "left" },
            { label: "Split Right", side: "right" },
            { label: "Split Up", side: "up" },
            { label: "Split Down", side: "down" },
          ] as const
        ).map(({ label, side }) => ({
          label,
          onClick: () => void splitPanel(ctx.leafId, side as SplitSide),
        })),
        { separator: true } as const,
        {
          label: "Copy",
          kbd: copyKbd,
          disabled: !hasSelection,
          onClick: () => {
            const text = xtermForCtx?.getSelection();
            if (text) void writeClipboard(text).catch(() => {});
          },
        },
        {
          label: "Paste",
          kbd: pasteKbd,
          onClick: () => {
            void readClipboard()
              .then((text) => {
                if (text) xtermForCtx?.paste(text);
              })
              .catch(() => {});
          },
        },
        { separator: true } as const,
        {
          label: "Close Panel",
          onClick: () => void closeActivePanel(),
        },
      ]
    : [];

  return (
    <>
      <Mosaic<string>
        className="mosaic-dark"
        value={tab.mosaic}
        onChange={onChange}
        renderTile={renderTile}
      />
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={menuItems}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
}

function PanelHeader({
  leafId,
  focused,
}: {
  leafId: string;
  focused: boolean;
}) {
  const show = useAppStore((s) => s.settings.showPanelHeader);
  const cwd = useAppStore((s) => s.terminals[leafId]?.cwd);
  const shellPath = useAppStore((s) => s.settings.shellPath);
  if (!show) return null;
  const shellName = (shellPath || "$SHELL")
    .replace(/^.*\//, "")
    .replace(/^\$/, "") || "shell";
  return (
    <div
      className={`panel__header ${focused ? "panel__header--focused" : ""}`}
      aria-hidden
    >
      <TerminalIcon size={10} className="panel__header-icon" />
      <span className="panel__header-shell">{shellName}</span>
      {cwd && (
        <>
          <span className="panel__header-sep">·</span>
          <span className="panel__header-cwd" title={cwd}>
            {cwdLabel(cwd)}
          </span>
        </>
      )}
      <span className="panel__header-spacer" />
      <span className="panel__header-dot" />
      <span className="panel__header-status">running</span>
    </div>
  );
}
