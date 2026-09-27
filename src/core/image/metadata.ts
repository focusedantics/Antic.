import exifr from "exifr";
import type { ExifSummary } from "@/core/catalog/types";

export type ParsedMetadata = {
  exif: ExifSummary;
  captureTime?: number;
  orientation?: number;
  width?: number;
  height?: number;
};

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().replace(/\0+$/, "") : undefined);
const nb = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function summarize(t: Raw): ParsedMetadata {
  const make = str(t.Make);
  let model = str(t.Model);
  if (make && model?.toLowerCase().startsWith(make.toLowerCase())) model = model.slice(make.length).trim();
  const date = t.DateTimeOriginal ?? t.CreateDate ?? t.DateTime ?? t.ModifyDate;
  const captureTime = date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : undefined;
  const orientationRaw = t.Orientation;
  const orientation =
    typeof orientationRaw === "number" ? orientationRaw : orientationFromText(str(orientationRaw));
  const iccDescription = str(t.ProfileDescription) ?? str(t.ICCProfileName);
  return {
    captureTime,
    orientation,
    width: nb(t.ExifImageWidth) ?? nb(t.ImageWidth) ?? nb(t.PixelXDimension),
    height: nb(t.ExifImageHeight) ?? nb(t.ImageHeight) ?? nb(t.PixelYDimension),
    exif: {
      make,
      model,
      lens: str(t.LensModel) ?? str(t.LensInfo) ?? str(t.Lens) ?? str(t.LensType),
      iso: nb(t.ISO) ?? nb(t.ISOSpeedRatings) ?? (Array.isArray(t.ISO) ? nb(t.ISO[0]) : undefined),
      exposureTime: nb(t.ExposureTime),
      fNumber: nb(t.FNumber),
      focalLength: nb(t.FocalLength),
      focalLength35: nb(t.FocalLengthIn35mmFormat),
      exposureBias: nb(t.ExposureCompensation),
      flash: str(t.Flash),
      meteringMode: str(t.MeteringMode),
      whiteBalance: str(t.WhiteBalance),
      software: str(t.Software),
      artist: str(t.Artist),
      copyright: str(t.Copyright),
      latitude: nb(t.latitude),
      longitude: nb(t.longitude),
      altitude: nb(t.GPSAltitude),
      colorSpace: str(t.ColorSpace),
      iccProfile: iccDescription,
    },
  };
}

function orientationFromText(text?: string): number | undefined {
  if (!text) return undefined;
  const map: Record<string, number> = {
    "Horizontal (normal)": 1,
    "Mirror horizontal": 2,
    "Rotate 180": 3,
    "Mirror vertical": 4,
    "Mirror horizontal and rotate 270 CW": 5,
    "Rotate 90 CW": 6,
    "Mirror horizontal and rotate 90 CW": 7,
    "Rotate 270 CW": 8,
  };
  return map[text];
}

const options = {
  tiff: true,
  exif: true,
  gps: true,
  icc: true,
  ifd1: false,
  xmp: false,
  iptc: false,
  interop: false,
  makerNote: false,
  userComment: false,
  translateValues: true,
  reviveValues: true,
  // Orientation must stay numeric for our geometry; exifr translates it otherwise.
  translateKeys: true,
  mergeOutput: true,
} as const;

export async function readMetadata(bytes: ArrayBuffer | Uint8Array, fallback?: Uint8Array): Promise<ParsedMetadata> {
  let parsed: Raw | undefined;
  try {
    parsed = (await exifr.parse(bytes, options)) as Raw | undefined;
  } catch {
    parsed = undefined;
  }
  if ((!parsed || !parsed.Make) && fallback) {
    try {
      const fromPreview = (await exifr.parse(fallback, options)) as Raw | undefined;
      if (fromPreview) parsed = { ...fromPreview, ...(parsed ?? {}) };
    } catch {
      // No EXIF anywhere; the summary stays empty.
    }
  }
  if (!parsed) return { exif: {} };
  const summary = summarize(parsed);
  try {
    const orientation = await exifr.orientation(bytes);
    if (typeof orientation === "number") summary.orientation = orientation;
  } catch {
    // Leave whatever the parse produced.
  }
  return summary;
}
