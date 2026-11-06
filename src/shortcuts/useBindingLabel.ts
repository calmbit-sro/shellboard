import { useMemo } from "react";
import { useAppStore } from "../store/appStore";
import { formatBinding } from "./binding";
import { resolveBindings } from "./registry";

/** Returns a lookup from action id to its current combo, as text for this
 *  platform. Follows the user's rebindings. */
export function useBindingLabel(): (id: string) => string {
  const keybindings = useAppStore((s) => s.settings.keybindings);
  return useMemo(() => {
    const resolved = resolveBindings(keybindings);
    return (id) => {
      const b = resolved[id];
      return b ? formatBinding(b) : "";
    };
  }, [keybindings]);
}
