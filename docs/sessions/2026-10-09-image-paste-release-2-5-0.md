# 2026-10-09 — Clipboard image paste + release 2.5.0

- **Branch:** master (commits `452e966`..`736c5b4`, all pushed)
- **Participants:** Petr + Claude (Opus 5.5)
- Continues [2026-10-09-dependency-updates](2026-10-09-dependency-updates.md).

## Context

Claude Code can take a screenshot straight from the clipboard, but in
Shellboard Cmd+V with an image on the clipboard did nothing. After the fix
we shipped it together with the day's dependency updates and the earlier
OSC 52 work as v2.5.0.

## What was done

- Root cause: Cmd+V and the context-menu Paste read only **text** from the
  clipboard (`readText`). An image-only clipboard gives no text, so nothing
  reached the PTY. Claude Code reads images itself (`osascript … «class
  PNGf»`), but only when it receives the **Ctrl+V** keypress. Confirmed from
  strings in the `claude` binary: the image-paste binding is `ctrl+v` on
  macOS/Linux.
- Fix: new `src/utils/clipboardPaste.ts` (`pasteClipboardInto`) handles both
  keyboard and context-menu paste. If the clipboard has text, it pastes it
  as before. If it has no text but has an image, it sends `\x16` via
  `xterm.input(…, true)` so it travels the normal onData → `write_to_pty`
  path. The image is only probed (`readImage` → `close()`); its pixels never
  cross IPC.
- Added the `clipboard-manager:allow-read-image` capability. Added a
  watch-out bullet to `CLAUDE.md`.
- Petr verified it in `tauri dev` (screenshot → `[Image #1]` in Claude Code).
- Release **v2.5.0** (minor version, not 2.4.2): version bumped in the 3
  files plus lockfiles, CHANGELOG section written. Tagged `v2.5.0`, CI
  green on all platforms. The workflow leaves a **draft** release, which I
  published with `gh release edit --draft=false --latest`.
- Fixed `CLAUDE.md`: the release matrix is macOS Apple Silicon + Linux +
  Windows (no x64 macOS), and the draft-publish step is now documented.

## Key decisions

- **Ctrl+V fallback only when the clipboard has an image.** We don't send
  `\x16` on every empty paste: in a plain shell `^V` is quoted-insert, which
  takes the next key literally. With an image present that side effect is
  accepted, since it's the same as pressing Ctrl+V yourself.
- Middle-click paste (`Terminal.tsx`, synthesized from the clipboard) was
  left text-only on purpose.
- On Windows Claude Code binds image paste to a different key, not Ctrl+V,
  so the fallback probably won't trigger it there. Not addressed, because
  Windows isn't a primary target.

## Open questions

- Windows image paste (see above): needs checking only if Windows users
  ask for it.

## Next steps

- Nothing pending from this session. Deferred items from the deps log still
  stand: react-mosaic 7 (drop the `uuid` override when doing it) and
  TypeScript 7.

## References

- Commits: `452e966` (image paste), `68da793` (prepare v2.5.0), `736c5b4`
  (CLAUDE.md release notes)
- Release: https://github.com/calmbit-sro/shellboard/releases/tag/v2.5.0
