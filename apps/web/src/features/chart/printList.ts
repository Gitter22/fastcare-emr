import type { PatientBanner } from "@agile-emr/shared";
import { formatDate } from "@/lib/format";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** Printable list (medications, allergies) with the patient's identity on the page (INV-ID-01 on paper). */
export function printList(b: PatientBanner, title: string, rows: Array<[string, string]>) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  w.document.title = title;
  w.document.body.innerHTML = `
    <style>body{font:14px/1.5 system-ui,sans-serif;margin:40px;color:#000}h1{font-size:20px;margin:0 0 4px}
    p{margin:0 0 16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 4px;border-bottom:1px solid #999}
    th{border-bottom:2px solid #000}</style>
    <h1>${esc(title)}</h1>
    <p><b>${esc(b.name)}</b> · DOB ${esc(formatDate(b.birthDate))} · MRN ${esc(b.mrn)} · printed ${esc(new Date().toLocaleDateString())}</p>
    <table><thead><tr><th>Item</th><th>Directions</th></tr></thead><tbody>
    ${rows.map(([a, c]) => `<tr><td>${esc(a)}</td><td>${esc(c)}</td></tr>`).join("")}
    </tbody></table>`;
  w.print();
}
