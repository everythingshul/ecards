import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { db } from '../db.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
export const CUSTOM_TEMPLATE_PATH = join(DATA_DIR, 'contracts', 'org-template.pdf');

export function hasCustomTemplate() { return existsSync(CUSTOM_TEMPLATE_PATH); }

// The admin-configured signature placement for a document kind ('shul' |
// 'applicant' | 'store'), set via Settings > Documents' drag/resize editor
// (routes/settings.js). Returns null if never configured, in which case
// stampSignature() below falls back to its original hardcoded placement.
export function getSignatureBox(orgId, kind) {
  const row = db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(orgId, `signature_box_${kind}`);
  return row ? JSON.parse(row.value) : null;
}

// Shared simple word-wrapping PDF body builder, used by both the shul
// contract and the generic applicant/store document generator below.
async function buildSimplePdf({ heading, subheading, fieldLines, bodyText }) {
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

  drawText(heading, { size: 18, useFont: bold, gap: 22 });
  drawText(subheading, { size: 13, useFont: bold, gap: 18 });
  y -= 8;
  for (const line of fieldLines) drawText(line, { size: 11 });
  y -= 10;
  drawText(bodyText, { size: 10.5, gap: 15 });

  return doc.save();
}

// Contract source is either (a) an admin-uploaded PDF (Settings > Documents >
// Shul Contract > Upload PDF) used as-is, or (b) a simple generated PDF built
// from the shul/season details + a plain-text clause. Either way the result
// is a per-shul "unsigned" PDF that stampSignature() below adds a signature to.
export async function generateContractPdf({ shul, season, templateText, orgName }) {
  const path = join(DATA_DIR, 'contracts', `${shul.id}-unsigned.pdf`);

  if (hasCustomTemplate()) {
    writeFileSync(path, readFileSync(CUSTOM_TEMPLATE_PATH));
    return path;
  }

  const bytes = await buildSimplePdf({
    heading: orgName,
    subheading: `Participation Agreement ${season?.name || ''}`.trim(),
    fieldLines: [
      `Shul: ${shul.name_en}${shul.name_he ? ' / ' + shul.name_he : ''}`,
      `Address: ${[shul.address, shul.city, shul.state, shul.zip].filter(Boolean).join(', ')}`,
      `Rav: ${shul.ruv_first_name || ''} ${shul.ruv_last_name || ''}  |  Phone: ${shul.ruv_phone || ''}`,
      `Gabai: ${shul.gabai_first_name || ''} ${shul.gabai_last_name || ''}  |  Cell: ${shul.gabai_cell || ''}  |  Email: ${shul.gabai_email || ''}`,
    ],
    bodyText: templateText || `By signing below, the undersigned, on behalf of the above shul, agrees to participate in the gift card assistance program for the current season, to submit applicant information accurately and in good faith, and to abide by the program's terms as communicated by the administering organization. The organization reserves the right to allocate a limited number of slots per season and to approve or decline individual applicants at its discretion.`,
  });
  writeFileSync(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// Generic documents (applicants + stores) — same idea as the shul contract
// above, generalized: each entity type gets its own optional uploaded PDF
// template, editable clause text, and default title/body when neither is set.
// ---------------------------------------------------------------------------
const DOC_TEMPLATE_PATHS = {
  applicant: join(DATA_DIR, 'contracts', 'org-template-applicant.pdf'),
  store: join(DATA_DIR, 'contracts', 'org-template-store.pdf'),
};
const DOC_DEFAULTS = {
  applicant: {
    subheading: 'Applicant Agreement',
    body: `By signing below, the undersigned applicant acknowledges receipt of a gift card issued through this program, agrees to use it in accordance with its intended purpose, and understands that misuse may result in deactivation and disqualification from future participation.`,
  },
  store: {
    subheading: 'Store Participation Agreement',
    body: `By signing below, the undersigned, on behalf of the above store, agrees to participate as an approved redemption location for gift cards issued through this program, to honor the card's stated balance at time of purchase, and to submit transaction and billing information accurately to the administering organization.`,
  },
};

export function docTemplatePath(entityType) { return DOC_TEMPLATE_PATHS[entityType]; }
export function hasCustomDocTemplate(entityType) { return DOC_TEMPLATE_PATHS[entityType] ? existsSync(DOC_TEMPLATE_PATHS[entityType]) : false; }

// entityType: 'applicant' | 'store'. fieldLines: array of plain summary lines
// (name/address/contact) drawn near the top of the generated fallback PDF.
export async function generateGenericDocumentPdf({ entityType, entityId, title, fieldLines, templateText, orgName }) {
  const path = join(DATA_DIR, 'contracts', `${entityType}-${entityId}-unsigned.pdf`);
  const templatePath = DOC_TEMPLATE_PATHS[entityType];

  if (templatePath && existsSync(templatePath)) {
    writeFileSync(path, readFileSync(templatePath));
    return path;
  }

  const defaults = DOC_DEFAULTS[entityType] || { subheading: title || 'Agreement', body: '' };
  const bytes = await buildSimplePdf({
    heading: orgName,
    subheading: title || defaults.subheading,
    fieldLines,
    bodyText: templateText || defaults.body,
  });
  writeFileSync(path, bytes);
  return path;
}

// Stamps a signature (base64 PNG or typed name) + metadata onto the last page
// of the unsigned PDF. `shulId` is really just "output file id" — callers
// for applicant/store documents pass a composite string like
// `applicant-<id>` here; the function itself has no shul-specific logic.
//
// `box` is the admin-configured signature placement from Settings >
// Documents ({x, y, width, height}, all fractions 0-1 of the page's actual
// size, TOP-LEFT origin — matches the drag/resize editor in the admin UI).
// Falls back to the original hardcoded "~16% up from the bottom-left"
// placement when no box has been configured yet for this document kind, so
// existing orgs see no change until they opt in.
export async function stampSignature({ unsignedPath, shulId, signatureDataUrl, signerName, signedAt, ip, box }) {
  const bytes = readFileSync(unsignedPath);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const { width: pw, height: ph } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let boxX, boxBottom, boxW, boxH;
  if (box && [box.x, box.y, box.width, box.height].every(v => typeof v === 'number' && v >= 0 && v <= 1)) {
    boxX = box.x * pw;
    boxW = Math.max(60, box.width * pw);
    boxH = Math.max(40, box.height * ph);
    boxBottom = ph - box.y * ph - boxH; // convert top-left-origin fraction to PDF's bottom-left points
  } else {
    const margin = Math.max(32, pw * 0.09);
    boxX = margin;
    boxW = Math.min(260, pw - margin * 2);
    boxH = Math.max(100, ph * 0.22);
    boxBottom = Math.max(60, ph * 0.16);
  }
  boxBottom = Math.max(10, boxBottom);

  const boxTop = boxBottom + boxH;
  const lineY = boxTop - boxH * 0.06;
  page.drawLine({ start: { x: boxX, y: lineY }, end: { x: boxX + boxW, y: lineY }, thickness: 1, color: rgb(0.3, 0.25, 0.2) });

  const sigAreaH = boxH * 0.48;
  if (signatureDataUrl && signatureDataUrl.startsWith('data:image/png;base64,')) {
    const pngBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
    const png = await doc.embedPng(pngBytes);
    const scale = Math.min(boxW / png.width, sigAreaH / png.height, 1);
    const dims = png.scale(scale);
    page.drawImage(png, { x: boxX, y: lineY - 4 - dims.height, width: dims.width, height: dims.height });
  } else {
    page.drawText(signerName || '', { x: boxX + 4, y: lineY - sigAreaH * 0.65, size: Math.min(20, sigAreaH * 0.55), font: bold, color: rgb(0.15, 0.11, 0.09) });
  }

  const lineGap = Math.max(9, boxH * 0.13);
  let textY = boxBottom + boxH * 0.4;
  page.drawText(`Signed by: ${signerName || ''}`, { x: boxX, y: textY, size: 10, font });
  textY = Math.max(boxBottom, textY - lineGap);
  page.drawText(`Date: ${signedAt}`, { x: boxX, y: textY, size: 9, font, color: rgb(0.4, 0.35, 0.3) });
  textY = Math.max(boxBottom - 4, textY - lineGap * 0.85);
  page.drawText(`IP: ${ip || 'n/a'}`, { x: boxX, y: textY, size: 8, font, color: rgb(0.5, 0.45, 0.4) });

  const outBytes = await doc.save();
  const outPath = join(DATA_DIR, 'contracts', `${shulId}-signed.pdf`);
  writeFileSync(outPath, outBytes);
  return outPath;
}
