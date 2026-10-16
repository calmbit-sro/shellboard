import { SETTINGS_LIMITS } from "../store/appStore";

// SETTINGS_LIMITS is read lazily: appStore imports this module (cycle).
/** Terminal font size actually rendered: the shared base setting plus this
 *  window's zoom offset, clamped to the allowed range. */
export function effectiveFontSize(base: number, offset: number): number {
  const { min, max } = SETTINGS_LIMITS.terminalFontSize;
  return Math.max(min, Math.min(max, base + offset));
}

/** Clamp a zoom offset so base + offset stays within the allowed range. */
export function clampZoomOffset(base: number, offset: number): number {
  return effectiveFontSize(base, offset) - base;
}
