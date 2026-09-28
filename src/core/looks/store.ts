import { createStore } from "zustand/vanilla";
import { deleteLook, listLooks, putLook } from "@/core/catalog/db";
import { type Look, sanitizeLook } from "./look";

export const looks = createStore<{ list: readonly Look[] }>(() => ({ list: [] }));

export async function refreshLooks() {
  const list = (await listLooks()).map(sanitizeLook).sort((a, b) => b.createdAt - a.createdAt);
  looks.setState({ list });
}

export async function saveLook(look: Look) {
  await putLook(look);
  await refreshLooks();
}

export async function removeLook(id: string) {
  await deleteLook(id);
  await refreshLooks();
}
