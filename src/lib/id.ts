/** Random, collision-resistant identifiers for catalog records and document nodes. */
export function createId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return prefix ? `${prefix}_${out.slice(0, 16)}` : out.slice(0, 16);
}
