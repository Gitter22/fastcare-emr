/** Pine overlay recipe: white surface, overlay shadow, fade + slight rise in, fade out (Pine rule 8). */
export const overlaySurface =
  "bg-surface text-ink shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-base data-[state=closed]:duration-fast";

export const scrim =
  "fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-base data-[state=closed]:duration-fast";
