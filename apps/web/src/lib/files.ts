/** Open a PDF (or other blob) the API returned in a new tab; the object URL is released after it loads. */
export function openBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return w;
}
