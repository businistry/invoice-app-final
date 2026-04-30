import fs from "node:fs/promises";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { InvoiceGlLine, StampPlacement, StampSettings } from "./types";

type StampPdfInput = {
  sourcePath: string;
  destinationPath: string;
  placement: StampPlacement;
  glLines: InvoiceGlLine[];
  totalAmount: number;
  settings: StampSettings;
  approvalDate: Date;
};

function currency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function approvalDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${month}/${day}/${value.getFullYear()}`;
}

export async function stampPdf(input: StampPdfInput): Promise<void> {
  const sourceBytes = await fs.readFile(input.sourcePath);
  const document = await PDFDocument.load(sourceBytes);
  const pageIndex = clamp(input.placement.pageIndex, 0, document.getPageCount() - 1);
  const page = document.getPage(pageIndex);
  const pageSize = page.getSize();
  const helvetica = await document.embedFont(StandardFonts.Helvetica);

  const width = clamp(input.placement.width, 240, pageSize.width - 24);
  const height = clamp(input.placement.height, 84, pageSize.height - 24);
  const x = clamp(input.placement.x, 12, pageSize.width - width - 12);
  const y = clamp(input.placement.y, 12, pageSize.height - height - 12);
  const fontSize = clamp(width / 48, 7.5, 11.5);
  const labelColor = rgb(0.02, 0.02, 0.02);
  const lineColor = rgb(0, 0, 0);
  const paddingX = 8;
  const innerLeft = x + paddingX;
  const innerRight = x + width - paddingX;
  const innerWidth = width - paddingX * 2;
  const top = y + height - fontSize - 8;
  const rowGap = (height - 24) / 5;
  const leftLabelX = innerLeft;
  const leftLineStart = innerLeft + innerWidth * 0.12;
  const leftLineEnd = innerLeft + innerWidth * 0.43;
  const rightLabelX = innerLeft + innerWidth * 0.48;
  const rightLineStart = innerLeft + innerWidth * 0.72;
  const rightLineEnd = innerRight;

  const drawText = (text: string, atX: number, atY: number, size = fontSize) => {
    page.drawText(text, {
      x: atX,
      y: atY,
      size,
      font: helvetica,
      color: labelColor,
      opacity: 0.95
    });
  };

  const drawLine = (startX: number, endX: number, lineY: number) => {
    page.drawLine({
      start: { x: startX, y: lineY },
      end: { x: endX, y: lineY },
      thickness: 0.8,
      color: lineColor,
      opacity: 0.85
    });
  };

  const normalizedLines = input.glLines.slice(0, 3);

  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderColor: lineColor,
    borderWidth: 1,
    opacity: 0.95
  });

  for (let index = 0; index < 3; index += 1) {
    const rowY = top - index * rowGap;
    const line = normalizedLines[index];
    drawText("GL#", leftLabelX, rowY);
    drawLine(leftLineStart, leftLineEnd, rowY - 2);
    drawText(line?.glCode || "", leftLineStart + 4, rowY + 1, fontSize * 0.92);

    drawText("Amount: $", rightLabelX, rowY);
    drawLine(rightLineStart, rightLineEnd, rowY - 2);
    drawText(currency(line?.amount), rightLineStart + 4, rowY + 1, fontSize * 0.92);
  }

  const totalY = top - 3.35 * rowGap;
  drawText("Amount Total: $", leftLabelX, totalY, fontSize * 1.02);
  drawLine(innerLeft + innerWidth * 0.37, rightLineEnd, totalY - 2);
  drawText(currency(input.totalAmount), innerLeft + innerWidth * 0.39, totalY + 1, fontSize * 0.92);

  const approvalY = top - 4.55 * rowGap;
  drawText("GM Approved:", leftLabelX, approvalY, fontSize * 1.02);
  drawLine(innerLeft + innerWidth * 0.32, innerLeft + innerWidth * 0.58, approvalY - 2);
  drawText(input.settings.gmInitials, innerLeft + innerWidth * 0.34, approvalY + 1, fontSize * 0.92);
  drawText("Date:", innerLeft + innerWidth * 0.64, approvalY, fontSize * 1.02);
  drawLine(innerLeft + innerWidth * 0.76, rightLineEnd, approvalY - 2);
  drawText(approvalDate(input.approvalDate), innerLeft + innerWidth * 0.78, approvalY + 1, fontSize * 0.92);

  const stampedBytes = await document.save();
  await fs.writeFile(input.destinationPath, stampedBytes);
}
