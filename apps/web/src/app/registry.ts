import type { ScreenId } from "@agile-emr/shared";

/**
 * Screens that have a built component. Navigation to anything else is hidden (NAV-09), so partial slices never
 * show dead links. App.tsx fills this from its route table.
 */
export const builtScreens = new Set<ScreenId>();
export const isBuilt = (id: ScreenId) => builtScreens.has(id);
