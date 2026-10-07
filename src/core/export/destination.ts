import { zip } from "fflate";

/** Where exported files go. Everything is written from this device; nothing is uploaded. */
export type DirectoryHandle = FileSystemDirectoryHandle & {
  getFileHandle(name: string, options: { create: boolean }): Promise<FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }>;
};

export type Destination =
  | { readonly kind: "download" }
  | { readonly kind: "zip" }
  | { readonly kind: "folder"; readonly handle: DirectoryHandle; readonly name: string };

export const canChooseFolder = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function chooseFolder(): Promise<Destination> {
  const handle = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirectoryHandle> }).showDirectoryPicker({ id: "focused-export", mode: "readwrite" });
  return { kind: "folder", handle, name: handle.name };
}

export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Names already used in this export run get " (2)", " (3)"… so nothing overwrites. */
export function uniqueName(name: string, used: Set<string>) {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A file name every system accepts: no path or reserved characters (a name like “Carousel 4:5” becomes “Carousel 4-5”). */
export function fileSafe(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[\s.]+|[\s.]+$/g, "") || "Untitled";
}

/**
 * Collects the files of one export run and delivers them. Downloads and folders
 * write each file as it's done; a ZIP is assembled at the end.
 */
export class ExportSink {
  private used = new Set<string>();
  private zipped: Record<string, Uint8Array> = {};
  private downloads: File[] = [];
  readonly saved: string[] = [];
  /**
   * Several downloads on a phone: the files, for the share sheet ("Save N Images" puts them
   * in Photos). It needs a tap of its own (`offerToSave`), as an export outlasts the one
   * that started it.
   */
  toShare: File[] | null = null;

  constructor(
    readonly destination: Destination,
    private readonly zipName = "Focused export.zip",
  ) {}

  async add(name: string, blob: Blob) {
    const file = uniqueName(fileSafe(name), this.used);
    const d = this.destination;
    if (d.kind === "download") this.downloads.push(new File([blob], file, { type: blob.type }));
    else if (d.kind === "zip") this.zipped[file] = new Uint8Array(await blob.arrayBuffer());
    else {
      const handle = await d.handle.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    }
    this.saved.push(file);
  }

  async finish() {
    if (this.destination.kind === "download") return this.deliverDownloads();
    if (this.destination.kind !== "zip" || !this.saved.length) return;
    const data = await new Promise<Uint8Array>((resolve, reject) =>
      // Images and videos are already compressed: store them without recompressing.
      zip(this.zipped, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out))),
    );
    this.zipped = {};
    download(fileSafe(this.zipName), new Blob([data as BlobPart], { type: "application/zip" }));
  }

  /**
   * Downloads started together are dropped by browsers but the last (Safari keeps one,
   * Chrome asks first): several files go one after another, a moment apart, or on a
   * phone to the share sheet.
   */
  private async deliverDownloads() {
    const files = this.downloads;
    this.downloads = [];
    if (files.length > 1 && phoneShare(files)) {
      this.toShare = files;
      return;
    }
    for (const [i, f] of files.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 700));
      download(f.name, f);
    }
  }
}

/** Phones and tablets that can hand several files to the share sheet. */
function phoneShare(files: File[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  const touch = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  try {
    return touch && navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Opens the share sheet with exported files; falls back to downloading them one by one. */
export async function shareFiles(files: File[]) {
  try {
    await navigator.share({ files });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    for (const [i, f] of files.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 700));
      download(f.name, f);
    }
  }
}

export function describeDestination(d: Destination) {
  switch (d.kind) {
    case "download":
      return "your Downloads";
    case "zip":
      return "a ZIP in your Downloads";
    case "folder":
      return `the folder “${d.name}”`;
  }
}
