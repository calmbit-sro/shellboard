import { useEffect, useState } from "react";
import { getName, getVersion, getTauriVersion } from "@tauri-apps/api/app";
import { Modal } from "./Modal";
import "./AboutDialog.css";

type AboutDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const [info, setInfo] = useState<{
    name: string;
    version: string;
    tauri: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const [name, version, tauri] = await Promise.all([
          getName(),
          getVersion(),
          getTauriVersion(),
        ]);
        setInfo({ name, version, tauri });
      } catch {
        setInfo({ name: "Shellboard", version: "?", tauri: "?" });
      }
    })();
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} maxWidth={400}>
      <div className="about">
        <img src="/logo.png" alt="Shellboard logo" className="about__logo" />
        <div className="about__name">{info?.name ?? "Shellboard"}</div>
        <div className="about__version">
          Version {info?.version ?? "…"}
        </div>
        <div className="about__tagline">
          Cross-platform terminal with per-project tabs & splits.
        </div>
        <div className="about__meta">
          Built with Tauri {info?.tauri ?? "…"} · React · xterm.js ·
          portable-pty
        </div>
        <button
          type="button"
          className="about__close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
