import type { MenuItem } from "@/components/Menu";
import type { MaskOperation } from "@/core/develop/recipe";

/** AI mask entries for the create/add menus. Filled in by the AI module (Stage 4). */
export function aiMenuItems(_maskId: string | null, _operation: MaskOperation): MenuItem[] {
  return [];
}
