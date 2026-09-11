/**
 * OSC 52 clipboard payload decoding.
 *
 * Programs write to the clipboard with `ESC ] 52 ; <selection> ; <base64> BEL`
 * (xterm's "Manipulate Selection Data"). xterm.js hands the OSC handler only
 * the part after `52;`, i.e. `<selection>;<base64>`. The selection field
 * (`c`, `p`, `s`, `0`–`7`, or empty) is ignored — Shellboard has one clipboard.
 *
 * Returns the decoded UTF-8 text, or `null` when there is nothing to write:
 * a read query (`?`), an empty payload, or malformed base64. The spec says an
 * invalid payload clears the selection; we deliberately leave the user's
 * clipboard alone instead. Never throws — it runs inside xterm's write queue,
 * where an escaping exception would corrupt parsing.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep < 0) return null;
  // Some programs wrap long base64 — strip all whitespace before decoding.
  const payload = data.slice(sep + 1).replace(/\s+/g, "");
  if (!payload || payload === "?") return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  if (!binary) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  return text ? text : null;
}
