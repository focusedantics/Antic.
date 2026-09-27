import type { DevelopRecipe } from "@/core/develop/recipe";

export type AssetId = string;
export type CollectionId = string;

export type FileKind = "raw" | "jpeg" | "png" | "tiff" | "heic" | "webp" | "avif" | "gif" | "bmp";

/**
 * Where the untouched original lives. The catalog never writes to it.
 * - `stored`: a copy of the file's bytes in the `originals` IndexedDB store.
 * - `handle`: a File System Access handle to the file on disk (Chromium). The
 *   file stays where it is; the browser may ask for permission again.
 */
export type OriginalRef =
  | { readonly kind: "stored" }
  | { readonly kind: "handle"; readonly handle: FileSystemFileHandle; readonly path: string };

export type Flag = "pick" | "reject" | null;
export type ColorLabel = "red" | "yellow" | "green" | "blue" | "purple" | null;

export type ExifSummary = {
  readonly make?: string;
  readonly model?: string;
  readonly lens?: string;
  readonly iso?: number;
  /** Seconds. */
  readonly exposureTime?: number;
  readonly fNumber?: number;
  /** Millimetres. */
  readonly focalLength?: number;
  readonly focalLength35?: number;
  readonly exposureBias?: number;
  readonly flash?: string;
  readonly meteringMode?: string;
  readonly whiteBalance?: string;
  readonly software?: string;
  readonly artist?: string;
  readonly copyright?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly altitude?: number;
  readonly colorSpace?: string;
  /** Name of an embedded ICC profile, when the file carries one. */
  readonly iccProfile?: string;
};

export type Asset = {
  readonly id: AssetId;
  readonly fileName: string;
  readonly kind: FileKind;
  readonly mime: string;
  readonly byteSize: number;
  readonly fileModified: number;
  readonly importedAt: number;
  /** Folder path at import, for folder browsing; "" for loose files. */
  readonly folder: string;
  readonly original: OriginalRef;
  /** Content fingerprint used to skip duplicate imports. */
  readonly fingerprint: string;

  /** Oriented pixel size of the full image, once known. */
  readonly width?: number;
  readonly height?: number;
  /** EXIF orientation 1..8 as recorded in the file. */
  readonly orientation?: number;
  /** Milliseconds since epoch. */
  readonly captureTime?: number;
  readonly exif: ExifSummary;

  readonly rating: number;
  readonly flag: Flag;
  readonly label: ColorLabel;
  readonly keywords: readonly string[];
  readonly title?: string;
  readonly caption?: string;
  readonly collectionIds: readonly CollectionId[];
  /** Stacks group near-duplicates; the top asset represents the stack when collapsed. */
  readonly stackId?: string;
  readonly stackIndex?: number;

  /** Absent means the photo has never been developed; defaults apply. */
  readonly develop?: DevelopRecipe;
  /** Bumped on every recipe change so derived previews can be invalidated. */
  readonly developRevision: number;
  /** Develop revision the stored thumbnail reflects; -1 means the camera/embedded rendering. */
  readonly thumbRevision: number;
  readonly thumbState: "pending" | "ready" | "error";
  readonly error?: string;
};

export type Collection = {
  readonly id: CollectionId;
  readonly name: string;
  readonly kind: "collection" | "smart";
  readonly parentId?: CollectionId;
  readonly createdAt: number;
  /** Only for smart collections. */
  readonly rules?: SmartRules;
};

export type SmartRule =
  | { readonly field: "rating"; readonly op: ">=" | "<=" | "="; readonly value: number }
  | { readonly field: "flag"; readonly op: "="; readonly value: "pick" | "reject" | "none" }
  | { readonly field: "label"; readonly op: "="; readonly value: Exclude<ColorLabel, null> | "none" }
  | { readonly field: "kind"; readonly op: "="; readonly value: FileKind }
  | { readonly field: "keyword"; readonly op: "contains"; readonly value: string }
  | { readonly field: "camera" | "lens" | "fileName" | "folder"; readonly op: "contains"; readonly value: string }
  | { readonly field: "iso" | "focalLength" | "fNumber"; readonly op: ">=" | "<="; readonly value: number }
  | { readonly field: "captureTime"; readonly op: ">=" | "<="; readonly value: number }
  | { readonly field: "edited"; readonly op: "="; readonly value: boolean };

export type SmartRules = { readonly match: "all" | "any"; readonly rules: readonly SmartRule[] };
