import type { CSSProperties, SVGProps } from "react";

type IconProps = {
  size?: number;
  stroke?: number;
  vb?: number;
  style?: CSSProperties;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, "stroke" | "style" | "className">;

function I({
  d,
  size = 14,
  stroke = 1.5,
  vb = 16,
  fillPath = false,
  style,
  className,
  ...rest
}: IconProps & { d: string; fillPath?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={fillPath ? "currentColor" : "none"}
      stroke={fillPath ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export const Plus = (p: IconProps) => <I {...p} d="M8 3v10M3 8h10" />;
export const Close = (p: IconProps) => <I {...p} d="M4 4l8 8M12 4l-8 8" />;
export const Search = (p: IconProps) => (
  <I
    {...p}
    d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5L13.5 13.5"
  />
);
export const Cog = (p: IconProps) => (
  <I
    {...p}
    d="M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v1.5M8 13v1.5M2.6 5l1.3.75M12.1 10.25l1.3.75M2.6 11l1.3-.75M12.1 5.75l1.3-.75"
  />
);
export const Folder = (p: IconProps) => (
  <I
    {...p}
    d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4a1 1 0 0 1 .77.36L7.6 4.5h4.9A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z"
  />
);
export const GitBranch = (p: IconProps) => (
  <I
    {...p}
    d="M4 2v12M12 2v3a3 3 0 0 1-3 3H4M12 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4 12.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"
  />
);
export const Terminal = (p: IconProps) => (
  <I {...p} d="M2 3.5h12v9H2zM4.5 6.5L6.5 8 4.5 9.5M7.5 10h3" />
);
export const Split = (p: IconProps) => (
  <I {...p} d="M2 3.5h12v9H2zM8 3.5v9" />
);
export const SplitH = (p: IconProps) => (
  <I {...p} d="M2 3.5h12v9H2zM2 8h12" />
);
export const Broadcast = (p: IconProps) => (
  <I
    {...p}
    d="M8 7v3M5 4.5a4 4 0 0 1 6 0M3.5 3a6.2 6.2 0 0 1 9 0M8 11.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"
  />
);
export const Sun = (p: IconProps) => (
  <I
    {...p}
    d="M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1.5v1.5M8 13v1.5M2.5 8H1M15 8h-1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1"
  />
);
export const Moon = (p: IconProps) => (
  <I {...p} d="M13 9.5A6 6 0 0 1 6.5 3a5 5 0 1 0 6.5 6.5z" />
);
export const SidebarIcon = (p: IconProps) => (
  <I {...p} d="M2 3.5h12v9H2zM6.5 3.5v9" />
);
export const ArrowUp = (p: IconProps) => (
  <I {...p} d="M8 13V3M4 7l4-4 4 4" />
);
export const ArrowDown = (p: IconProps) => (
  <I {...p} d="M8 3v10M4 9l4 4 4-4" />
);
export const Check = (p: IconProps) => <I {...p} d="M3 8.5L6.5 12 13 4.5" />;

export function Chevron({
  open = false,
  size = 9,
  style,
}: {
  open?: boolean;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 9 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform .15s",
        ...style,
      }}
    >
      <path d="M3 1.5L6 4.5L3 7.5" />
    </svg>
  );
}

export function Logo({ size = 20 }: { size?: number; color?: string }) {
  // The shipped PNG is green; rotate the hue to a chrome-friendly blue so
  // the mark reads against the matte-dark sidebar / topbar surfaces.
  return (
    <img
      src="/logo.png"
      width={size}
      height={size}
      alt="ShellBoard"
      draggable={false}
      style={{
        display: "block",
        flexShrink: 0,
        filter: "brightness(1.35) saturate(0.7)",
      }}
    />
  );
}
