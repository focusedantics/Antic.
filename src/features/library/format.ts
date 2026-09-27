export function formatExposure(seconds: number) {
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}″`;
  return `1/${Math.round(1 / seconds)}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
export const formatDate = (ms?: number) => (ms ? dateFormat.format(new Date(ms)) : undefined);

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
