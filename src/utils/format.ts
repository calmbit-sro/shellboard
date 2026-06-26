/**
 * Human-readable byte count, e.g. for RAM readouts in the Running-apps modal.
 * Uses decimal (1000-based) units to match what macOS Activity Monitor shows,
 * so the gauge lines up with the number users compare it against:
 *
 *   1_900_000_000 → "1.9 GB"
 *     340_000_000 → "340 MB"
 *      12_000_000 → "12 MB"
 *         512_000 → "512 KB"
 *             900 → "900 B"
 *
 * Sub-GB values round to whole units; GB keeps one decimal so growth is visible.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
