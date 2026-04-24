import type { Terminal as XTerm } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

/**
 * Central registry of mounted xterm instances, keyed by PTY session id.
 * Used by features that need to inspect multiple terminals at once
 * (global search, buffer serialization for session persistence, …).
 *
 * Terminal components register on mount and unregister on dispose.
 */
type Entry = {
  xterm: XTerm;
  serializer: SerializeAddon;
};

const instances = new Map<string, Entry>();

export function registerTerminal(
  id: string,
  xterm: XTerm,
  serializer: SerializeAddon,
): void {
  instances.set(id, { xterm, serializer });
}

export function unregisterTerminal(id: string): void {
  instances.delete(id);
}

export function getTerminal(id: string): XTerm | undefined {
  return instances.get(id)?.xterm;
}

export function getSerializer(id: string): SerializeAddon | undefined {
  return instances.get(id)?.serializer;
}

export type TerminalEntry = { id: string; xterm: XTerm };

export function listTerminals(): TerminalEntry[] {
  return Array.from(instances.entries()).map(([id, { xterm }]) => ({
    id,
    xterm,
  }));
}

/**
 * xterm.write() queues data and parses it asynchronously. Callers that
 * need to read a consistent buffer state (e.g. serialize before session
 * save) must first drain every terminal's queue. Writing an empty chunk
 * and waiting for its callback is a cheap way to flush the pipeline.
 */
export async function flushAllWrites(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const { xterm } of instances.values()) {
    pending.push(
      new Promise<void>((resolve) => {
        try {
          xterm.write("", () => resolve());
        } catch {
          resolve();
        }
      }),
    );
  }
  await Promise.all(pending);
}
