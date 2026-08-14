import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
export const CUSTOM_TEMPLATE_PATH = join(DATA_DIR, 'contracts', 'org-template.pdf');

export function hasCustomTemplate() { return existsSync(CUSTOM_TEMPLATE_PATH); }

// Contract source is either (a) an admin-uploaded PDF (Settings > Contract
// Template > Upload PDF) used as-is, or (b) a simple generated PDF built
// from the shul/season details + a plain-text clause (Settings > Contract
// Template > Template Text). Either way the result is a per-shul "unsigned"
// PDF that stampSignature() below adds a signature to.
export async function generateContractPdf({ shul, season, templateText, orgName }) {
  const path = join(DATA_DIR, 'contracts', `${shul.id}-unsigned.pdf`);

  if (hasCustomTemplate()) {
    // Uploaded PDF used verbatim as the contract body — the signature is
    // stamped onto its last page at sign time (see stampSignature).
    writeFileSync(path, readFileSync(CUSTOM_TEMPLATE_PATH));
    return path;
  }

  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  let y = 792 - margin;

  const drawText = (text, opts = {}) => {
    const { size = 11, useFont = font, color = rgb(0.15, 0.11, 0.09), gap = 16 } = opts;
    const maxWidth = 612 - margin * 2;
    const words = String(text).split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (useFont.widthOfTextAtSize(test, size) > maxWidth) {
        page.drawText(line, { x: margin, y, size, font: useFont, color });
        y -= gap;
        if (y < margin) { page = doc.addPage([612, 792]); y = 792 - margin; }
        line = word;
      } else line = test;
    }
    if (line) { page.drawText(line, { x: margin, y, size, font: useFont, color }); y -= gap; }
    y -= 6;
  };

  drawText(orgName, { size: 18, useFont: bold, gap: 22 });
  drawText(`Participation Agreement — ${season?.name || ''}`, { size: 13, useFont: bold, gap: 18 });
  y -= 8;
  drawText(`Shul: ${shul.name_en}${shul.name_he ? ' / ' + shul.name_he : ''}`, { size: 11 });
  drawText(`Address: ${[shul.address, shul.city, shul.state, shul.zip].filter(Boolean).join(', ')}`, { size: 11 });
  drawText(`Rav: ${shul.ruv_first_name || ''} ${shul.ruv_last_name || ''}  |  Phone: ${shul.ruv_phone || ''}`, { size: 11 });
  drawText(`Gabai: ${shul.gabai_first_name || ''} ${shul.gabai_last_name || ''}  |  Cell: ${shul.gabai_cell || ''}  |  Email: ${shul.gabai_email || ''}`, { size: 11 });
  y -= 10;

  const body = templateText || `By signing below, the undersigned, on behalf of the above shul, agrees to participate in the gift card assistance program for the current season, to submit applicant information accurately and in good faith, and to abide by the program's terms as communicated by the administering organization. The organization reserves the right to allocate a limited number of slots per season and to approve or decline individual applicants at its discretion.`;
  drawText(body, { size: 10.5, gap: 15 });

  const bytes = await doc.save();
  writeFileSync(path, bytes);
  return path;
}

// Stamps a signature (base64 PNG or typed name) + metadata onto the last page
// of the unsigned PDF. Positioned relative to the actual page size so this
// works correctly whether the PDF is our generated Letter-size doc or an
// admin-uploaded PDF of any dimensions.
export async function stampSignature({ unsignedPath, shulId, signatureDataUrl, signerName, signedAt, ip }) {
  const bytes = readFileSync(unsignedPath);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const { width: pw, height: ph } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = Math.max(32, pw * 0.09);
  const sigY = Math.max(60, ph * 0.16); // signature block ~16% up from the bottom of the last page
  const lineWidth = Math.min(260, pw - margin * 2);

  page.drawLine({ start: { x: margin, y: sigY + 40 }, end: { x: margin + lineWidth, y: sigY + 40 }, thickness: 1, color: rgb(0.3, 0.25, 0.2) });

  if (signatureDataUrl && signatureDataUrl.startsWith('data:image/png;base64,')) {
    const pngBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
    const png = await doc.embedPng(pngBytes);
    const dims = png.scale(0.35);
    page.drawImage(png, { x: margin, y: sigY + 42, width: Math.min(dims.width, lineWidth), height: Math.min(dims.height, 70) });
  } else {
    page.drawText(signerName || '', { x: margin + 4, y: sigY + 50, size: 20, font: bold, color: rgb(0.15, 0.11, 0.09) });
  }

  page.drawText(`Signed by: ${signerName || ''}`, { x: margin, y: sigY + 20, size: 10, font });
  page.drawText(`Date: ${signedAt}`, { x: margin, y: sigY + 5, size: 9, font, color: rgb(0.4, 0.35, 0.3) });
  page.drawText(`IP: ${ip || 'n/a'}`, { x: margin, y: sigY - 10, size: 8, font, color: rgb(0.5, 0.45, 0.4) });

  const outBytes = await doc.save();
  const outPath = join(DATA_DIR, 'contracts', `${shulId}-signed.pdf`);
  writeFileSync(outPath, outBytes);
  return outPath;
}
