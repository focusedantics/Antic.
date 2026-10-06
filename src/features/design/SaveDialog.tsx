import { useId, useState } from "react";
import { useStore } from "@/app/hooks";
import { Dialog } from "@/components/Menu";
import { designAssets, foldersOf } from "@/core/design/assets";
import { composite } from "@/core/document/session";
import { saveAsTemplate, saveSelectionAsElement } from "./actions";

/** Name and folder for a template or an element being saved. */
export function SaveAssetDialog({ kind, onClose }: { kind: "template" | "element"; onClose: () => void }) {
  const doc = useStore(composite, (s) => s.doc);
  const items = useStore(designAssets, (s) => s.items);
  const folders = foldersOf(items, kind).filter(Boolean);
  const [name, setName] = useState(kind === "template" ? (doc?.name ?? "My template") : "My element");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const list = useId();
  const save = async () => {
    setSaving(true);
    try {
      await (kind === "template" ? saveAsTemplate(name, folder) : saveSelectionAsElement(name, folder));
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={kind === "template" ? "Save as template" : "Save as element"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving || !name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="faint" style={{ marginTop: 0 }}>
        {kind === "template" ? "Keeps the whole design to start new ones from. Photo frames are saved empty." : "Keeps the selected layers to add to any design from Elements → Mine."}
      </p>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} autoFocus onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 8 }}>
        <span>Folder</span>
        <input className="input" list={list} placeholder="None (use / for subfolders)" value={folder} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setFolder(e.target.value)} />
        <datalist id={list}>
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
    </Dialog>
  );
}
