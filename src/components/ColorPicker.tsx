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
