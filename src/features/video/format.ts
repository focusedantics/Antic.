/** 1:02.35 (or 1:02 without fractions). */
export function formatClock(seconds: number, fractions = true) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return fractions ? `${m}:${rest.toFixed(2).padStart(5, "0")}` : `${m}:${Math.floor(rest).toString().padStart(2, "0")}`;
}
