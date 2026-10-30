import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { supplierDeliveryProjection, type SupplierPacket } from "../../modules/fulfillment/workflow.ts";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 52;

function splitLine(text: string, maxWidth: number, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const parts: string[] = [];
    let remaining = word;
    while (remaining && font.widthOfTextAtSize(remaining, size) > maxWidth) {
      let cut = 1;
      while (cut < remaining.length && font.widthOfTextAtSize(remaining.slice(0, cut + 1), size) <= maxWidth) cut += 1;
      parts.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) parts.push(remaining);
    for (const part of parts) {
      const candidate = current ? `${current} ${part}` : part;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = part;
      } else current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export async function buildSupplierPacketPdf(packet: SupplierPacket): Promise<Uint8Array> {
  const delivery = supplierDeliveryProjection(packet);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`GPHKM publication instructions ${delivery.id} v${delivery.version}`);
  pdf.setSubject("Supplier-specific publication packet");
  pdf.setCreator("GPHKM");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages: ReturnType<typeof pdf.addPage>[] = [];
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN;

  const startPage = () => { page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]); pages.push(page); y = PAGE_HEIGHT - MARGIN; };
  const drawText = (text: string, options: { font?: typeof regular; size?: number; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) => {
    const font = options.font ?? regular;
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const gap = options.gap ?? size * 1.45;
    const width = PAGE_WIDTH - MARGIN * 2 - indent;
    for (const paragraph of text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?").split(/\r?\n/)) {
      for (const line of splitLine(paragraph.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), width, font, size)) {
        if (y < MARGIN + 28) startPage();
        page.drawText(line, { x: MARGIN + indent, y, size, font, color: options.color ?? rgb(0.12, 0.16, 0.22) });
        y -= gap;
      }
    }
  };

  drawText("GPHKM - Publication instructions", { font: bold, size: 18, color: rgb(0.08, 0.2, 0.27), gap: 26 });
  drawText(`Packet ${delivery.id} - Version ${delivery.version}`, { size: 9, color: rgb(0.32, 0.39, 0.45), gap: 22 });
  drawText("Please follow the requirements for each placement below. The approved article and link instructions are included only for this packet.", { size: 10, gap: 18 });

  for (const [index, item] of delivery.items.entries()) {
    if (y < 170) startPage();
    if (index > 0) y -= 12;
    drawText(`Placement ${index + 1} - ${item.reference}`, { font: bold, size: 13, color: rgb(0.08, 0.2, 0.27), gap: 20 });
    for (const requirement of item.placementRequirements) drawText(`Requirement: ${requirement}`, { size: 9, indent: 8 });
    drawText(`Target URL: ${item.targetUrl}`, { size: 9, indent: 8 });
    drawText(`Anchor text: ${item.anchorText}`, { size: 9, indent: 8, gap: 14 });
    if (item.instructions) {
      drawText("Additional instructions", { font: bold, size: 10, gap: 14 });
      drawText(item.instructions, { size: 9, indent: 8, gap: 12 });
      y -= 5;
    }
    drawText("Approved article", { font: bold, size: 10, gap: 14 });
    drawText(item.article, { size: 9, indent: 8, gap: 12 });
    y -= 8;
  }
  drawText(`Packet reference: ${delivery.id}`, { font: bold, size: 9, color: rgb(0.32, 0.39, 0.45), gap: 13 });
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: MARGIN, y: 36 }, end: { x: PAGE_WIDTH - MARGIN, y: 36 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.9) });
    current.drawText(`Confidential supplier packet  -  ${delivery.id}  -  ${index + 1} / ${pages.length}`, { x: MARGIN, y: 22, size: 8, font: regular, color: rgb(0.42, 0.47, 0.52) });
  });
  return pdf.save({ useObjectStreams: false });
}
