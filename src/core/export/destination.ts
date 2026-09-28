import { zip } from "fflate";

/**
 * Where exported files go. Everything is written from this device; nothing is
 * uploaded unless Google Drive is chosen, and then only the exported files.
 */
export type DirectoryHandle = FileSystemDirectoryHandle & {
  getFileHandle(name: string, options: { create: boolean }): Promise<FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }>;
};

export type Destination =
  | { readonly kind: "download" }
  | { readonly kind: "zip" }
  | { readonly kind: "folder"; readonly handle: DirectoryHandle; readonly name: string }
  | { readonly kind: "drive"; readonly token: string; readonly folderId: string; readonly folderName: string };

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

/**
 * Collects the files of one export run and delivers them. Downloads and folders
 * write each file as it's done; a ZIP is assembled at the end.
 */
export class ExportSink {
  private used = new Set<string>();
  private zipped: Record<string, Uint8Array> = {};
  readonly saved: string[] = [];

  constructor(
    readonly destination: Destination,
    private readonly zipName = "Focused export.zip",
  ) {}

  async add(name: string, blob: Blob) {
    const file = uniqueName(name, this.used);
    const d = this.destination;
    if (d.kind === "download") download(file, blob);
    else if (d.kind === "zip") this.zipped[file] = new Uint8Array(await blob.arrayBuffer());
    else if (d.kind === "folder") {
      const handle = await d.handle.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      const { uploadToDrive } = await import("./drive");
      await uploadToDrive(d.token, d.folderId, file, blob);
    }
    this.saved.push(file);
  }

  async finish() {
    if (this.destination.kind !== "zip" || !this.saved.length) return;
    const data = await new Promise<Uint8Array>((resolve, reject) =>
      // Images and videos are already compressed: store them without recompressing.
      zip(this.zipped, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out))),
    );
    this.zipped = {};
    download(this.zipName, new Blob([data as BlobPart], { type: "application/zip" }));
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
    case "drive":
      return `Google Drive › ${d.folderName}`;
  }
}
