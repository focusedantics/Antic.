import { copyEdits, pasteEdits } from "@/features/develop/copy-edits";
import { flush } from "@/core/catalog/store";
import { compare, flag, label, rate, removeSelected, selectAll, step } from "@/features/library/commands";
import { currentOrder } from "@/features/library/results";
import { stackAssets } from "@/core/catalog/store";
import { openExport } from "@/features/export/host";
import { prefs, setPrefs } from "./prefs";
import { setWorkspace, targetIds, ui } from "./state";

/**
 * Workspace-specific handlers register here; the global handler tries the
 * active workspace first and falls back to the shared bindings below.
 */
type Handler = (e: KeyboardEvent) => boolean;
const workspaceHandlers = new Map<string, Handler>();
export function registerShortcuts(workspace: string, handler: Handler) {
  workspaceHandlers.set(workspace, handler);
  return () => {
    if (workspaceHandlers.get(workspace) === handler) workspaceHandlers.delete(workspace);
  };
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
};

export function handleKey(e: KeyboardEvent) {
  if (isTyping(e) || e.defaultPrevented) return;
  const { workspace } = ui.getState();
  if (workspaceHandlers.get(workspace)?.(e)) {
    e.preventDefault();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  let handled = true;
  if (mod && key === "a") selectAll();
  else if (mod && key === "s") void flush();
  else if (mod && key === "g") stackAssets(targetIds());
  else if (mod && e.shiftKey && key === "e") openExport(targetIds());
  else if (mod && e.shiftKey && key === "c" && workspace === "library") copyEdits(ui.getState().activeId);
  else if (mod && e.shiftKey && key === "v" && workspace === "library") pasteEdits(targetIds());
  else if (mod) handled = false;
  else if (key === "g" && !e.shiftKey) {
    setWorkspace("library");
    ui.setState({ libraryView: "grid" });
  } else if (key === "e") {
    setWorkspace("library");
    ui.setState({ libraryView: "loupe" });
  } else if (key === "c" && e.shiftKey) compare(targetIds().length >= 2 ? targetIds() : currentOrder().slice(0, 2));
  else if (key === "n") {
    setWorkspace("library");
    ui.setState({ libraryView: "survey" });
  } else if (key === "d") setWorkspace("develop");
  else if (key === "c") setWorkspace("composite");
  else if (key === "b") setWorkspace("design");
  else if (key === "tab") {
    const both = prefs.getState().showLeft && prefs.getState().showRight;
    setPrefs({ showLeft: !both, showRight: !both });
  } else if (key === "f" && e.shiftKey) setPrefs({ showFilmstrip: !prefs.getState().showFilmstrip });
  else if (key === "arrowright") step(1);
  else if (key === "arrowleft") step(-1);
  else if (workspace === "library" && /^[0-5]$/.test(key)) rate(Number(key));
  else if (/^[6-9]$/.test(key)) label((["red", "yellow", "green", "blue"] as const)[Number(key) - 6]);
  else if (key === "p") flag("pick");
  else if (key === "x") flag("reject");
  else if (key === "u") flag(null);
  else if ((key === "delete" || key === "backspace") && workspace === "library") void removeSelected();
  else if (key === "escape" && workspace === "library" && ui.getState().libraryView !== "grid") ui.setState({ libraryView: "grid" });
  else handled = false;
  if (handled) e.preventDefault();
}
