import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Class merge. tailwind-merge learns Pine's type scale so `text-body` (size) and `text-ink` (colour) don't cancel.
 */
const merge = extendTailwindMerge({
  extend: {
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
