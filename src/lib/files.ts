import { appleTouch } from "./device";

/**
 * Opens the system file picker and resolves with the chosen files ([] when it is
 * dismissed).
 *
 * The input sits in the document until a choice arrives: iOS Safari (and so
 * every browser on iPhone and iPad, which all use WebKit) never fires `change`
 * for an input that isn't in the document, and may collect it while the picker
 * is open, dropping the selection.
 */
export function chooseFiles(options: { accept?: string; multiple?: boolean; directory?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!options.multiple;
    if (options.accept) input.accept = options.accept;
    if (options.directory) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    Object.assign(input.style, { position: "fixed", left: "-9999px", top: "0", width: "1px", height: "1px", opacity: "0" });
    document.body.append(input);
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

/**
 * The accept list for a picker. On iPhone and iPad a list of specific types
 * changes what the photo library hands over (naming HEIC makes Safari 17+
 * convert every JPEG and PNG to HEIC first), and types iOS doesn't know, like
 * `.focused`, grey files out in Files. There, `image/*` and `video/*` let the
 * library offer everything (HEIC arrives as JPEG), and pickers for our own
 * files take any file (their contents are checked anyway).
 */
export function pickerAccept(desktop: string, phone: { images?: boolean; videos?: boolean; extra?: string }): string {
  if (!appleTouch()) return desktop;
  return [phone.images && "image/*", phone.videos && "video/*", phone.extra].filter(Boolean).join(",");
}

/** Saves a blob as a download (the browser's file save). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
