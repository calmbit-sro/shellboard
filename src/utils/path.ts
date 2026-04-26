/**
 * Compact label for a working directory, used in tab captions and the
 * sidebar caption of quick-add projects. Format:
 *
 *   /Users/petr/cnc/partner-hub  → "cnc/partner-hub"
 *   /Users/petr/Projects/foo     → "Projects/foo"
 *   /tmp                         → "/tmp"
 *   /                            → "/"
 *   ""                           → ""
 *
 * Two trailing segments give just enough context to disambiguate
 * sibling projects without crowding the UI; CSS ellipsis handles
 * overflow visually and a `title` tooltip exposes the full path.
 */
export function cwdLabel(path: string): string {
  if (!path) return "";
  const norm = path.replace(/[\\/]+$/, "");
  if (!norm) return "/";
  const parts = norm.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return "/";
  if (parts.length === 1) return `/${parts[0]}`;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
