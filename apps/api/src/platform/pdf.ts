import PDFDocument from "pdfkit";

/**
 * Printable clinical documents (signed note, AVS). Letter size, Helvetica, black on white. Every page repeats the
 * patient identity line (INV-ID-01 applies to paper too) and numbers itself "Page n of N".
 */
export interface PdfIdentity {
  title: string;
  patientLine: string;
  practiceName: string;
}

export type PdfWriter = {
  heading(text: string): void;
  subheading(text: string): void;
  paragraph(text: string): void;
  keyValue(rows: Array<[string, string]>): void;
  list(items: string[]): void;
  spacer(): void;
  muted(text: string): void;
};

export function renderPdf(identity: PdfIdentity, build: (w: PdfWriter) => void): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 90, bottom: 60, left: 60, right: 60 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - 120;
  const w: PdfWriter = {
    heading: (t) =>
      doc.moveDown(0.6).font("Helvetica-Bold").fontSize(13).fillColor("#000").text(t, { width }),
    subheading: (t) =>
      doc
        .moveDown(0.4)
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .text(t.toUpperCase(), { width, characterSpacing: 0.4 }),
    paragraph: (t) =>
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor("#000")
        .text(t || "—", { width, lineGap: 2 }),
    keyValue: (rows) => {
      for (const [k, v] of rows)
        doc
          .font("Helvetica-Bold")
          .fontSize(10.5)
          .text(`${k}: `, { continued: true })
          .font("Helvetica")
          .text(v || "—");
    },
    list: (items) =>
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .list(items.length ? items : ["None"], { width, bulletRadius: 1.6 }),
    spacer: () => doc.moveDown(0.5),
    muted: (t) =>
      doc.font("Helvetica").fontSize(9).fillColor("#444").text(t, { width }).fillColor("#000"),
  };
  build(w);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const top = 36;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#000")
      .text(identity.practiceName, 60, top, { width, lineBreak: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(identity.title, 60, top + 14, { width, lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .text(identity.patientLine, 60, top + 32, { width, lineBreak: false });
    doc
      .moveTo(60, top + 46)
      .lineTo(60 + width, top + 46)
      .lineWidth(0.8)
      .stroke("#000");
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#444")
      .text(`Page ${i - range.start + 1} of ${range.count}`, 60, doc.page.height - 40, {
        width,
        align: "right",
        lineBreak: false,
      });
    doc.fillColor("#000");
  }
  doc.end();
  return done;
}
