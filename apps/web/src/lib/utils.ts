import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Class merge. tailwind-merge learns Pine's type scale so `text-body` (size) and `text-ink` (colour) don't cancel,
 * and Pine's spacing tokens so `w-dialog-sm` yields to a caller's `w-[680px]`.
 */
const merge = extendTailwindMerge({
  extend: {
    // Pine's named spacing tokens (pine-theme.css --spacing-*): w-dialog-sm, h-control-md, size-control-sm, …
    theme: {
      spacing: [
        "control-sm",
        "control-md",
        "control-lg",
        "row-compact",
        "row-default",
        "sidebar",
        "dialog-sm",
      ],
    },
    classGroups: {
      "font-size": [
        { text: ["display", "h1", "h2", "h3", "body-lg", "body", "label", "small", "caption"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
