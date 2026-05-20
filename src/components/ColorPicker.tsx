import { useState } from "react";
import "./ColorPicker.css";

export const PROJECT_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
  "#64748b", // slate
];

export function randomProjectColor(): string {
  return PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const v = lN - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Pick a color for a new project that isn't already used in the given set.
 * Prefers an unused color from PROJECT_COLORS; if all are taken, generates
 * a random color outside both the palette and the used set.
 */
export function pickUnusedProjectColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  const available = PROJECT_COLORS.filter((c) => !used.has(c.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  const palette = new Set(PROJECT_COLORS.map((c) => c.toLowerCase()));
  for (let i = 0; i < 50; i++) {
    const hue = Math.floor(Math.random() * 360);
    const sat = 55 + Math.floor(Math.random() * 26); // 55–80
    const light = 50 + Math.floor(Math.random() * 16); // 50–65
    const hex = hslToHex(hue, sat, light).toLowerCase();
    if (!used.has(hex) && !palette.has(hex)) return hex;
  }
  return randomProjectColor();
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
};

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [custom, setCustom] = useState(
    PROJECT_COLORS.includes(value) ? "" : value,
  );

  return (
    <div className="color-picker">
      <div className="color-picker__swatches">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`color-picker__swatch ${
              value.toLowerCase() === c.toLowerCase()
                ? "color-picker__swatch--selected"
                : ""
            }`}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => {
              setCustom("");
              onChange(c);
            }}
          />
        ))}
      </div>
      <div className="color-picker__custom">
        <label>
          Custom:
          <input
            type="text"
            placeholder="#a1b2c3"
            value={custom}
            maxLength={7}
            onChange={(e) => {
              const next = e.target.value;
              setCustom(next);
              if (HEX_RE.test(next)) onChange(next);
            }}
          />
        </label>
      </div>
    </div>
  );
}
