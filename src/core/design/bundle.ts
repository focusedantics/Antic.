import { strFromU8, strToU8, unzip, zip } from "fflate";
import { assetData, cleanFolder, type DesignAsset, type DesignAssetKind, saveDesignAsset } from "./assets";

/**
 * A `.focusedkit` file: design assets (templates, elements, palettes, gradients, brushes,
 * fonts) to move to another device or share. A zip with `kit.json` (the records) and the
 * binary parts (font files, brush tips, thumbnails) as files beside it. Imported records
 * are validated like any other read and get new ids.
 */
const FORMAT = "focused-kit/1";
type FileRef = { $file: string; type: string };

export async function exportBundle(assets: readonly DesignAsset[]): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const pack = async (id: string, key: string, v: unknown): Promise<unknown> => {
    if (!(v instanceof Blob)) return v;
    const path = `files/${id}/${key}`;
    files[path] = new Uint8Array(await v.arrayBuffer());
    return { $file: path, type: v.type } satisfies FileRef;
  };
  const records = [];
  for (const a of assets) {
    const data = a.data && typeof a.data === "object" ? Object.fromEntries(await Promise.all(Object.entries(a.data as Record<string, unknown>).map(async ([k, v]) => [k, await pack(a.id, k, v)] as const))) : a.data;
    records.push({ kind: a.kind, name: a.name, folder: a.folder, data, ...(a.thumb ? { thumb: await pack(a.id, "thumb", a.thumb) } : {}) });
  }
  files["kit.json"] = strToU8(JSON.stringify({ format: FORMAT, assets: records }));
  const zipped = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))));
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

/** Imports a `.focusedkit`; returns how many assets were added (invalid ones are skipped). */
export async function importBundle(file: Blob, intoFolder = ""): Promise<number> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, (err, data) => (err ? reject(err) : resolve(data))));
  const raw = entries["kit.json"];
  if (!raw) throw new Error("Not a Focused kit: kit.json is missing.");
  const json = JSON.parse(strFromU8(raw)) as { format?: unknown; assets?: unknown };
  if (json.format !== FORMAT || !Array.isArray(json.assets)) throw new Error("Not a Focused kit.");
  const unpack = (v: unknown): unknown => {
    const ref = v && typeof v === "object" && typeof (v as FileRef).$file === "string" ? (v as FileRef) : null;
    if (!ref) return v;
    const data = entries[ref.$file];
    return data ? new Blob([data as BlobPart], { type: typeof ref.type === "string" ? ref.type : "" }) : null;
  };
  let added = 0;
  for (const r of json.assets.slice(0, 2000)) {
    if (!r || typeof r !== "object") continue;
    const rec = r as { kind?: unknown; name?: unknown; folder?: unknown; data?: unknown; thumb?: unknown };
    const kind = rec.kind as DesignAssetKind;
    const data = rec.data && typeof rec.data === "object" ? Object.fromEntries(Object.entries(rec.data as Record<string, unknown>).map(([k, v]) => [k, unpack(v)])) : rec.data;
    if (!assetData({ kind, data })) continue;
    const thumb = unpack(rec.thumb);
    const folder = [cleanFolder(intoFolder), cleanFolder(rec.folder)].filter(Boolean).join("/");
    try {
      await saveDesignAsset(kind, typeof rec.name === "string" ? rec.name : "Imported", data, { folder, thumb: thumb instanceof Blob ? thumb : undefined });
      added++;
    } catch {
      // Skipped: not valid for its kind.
    }
  }
  return added;
}
