import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { db } from '../db.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
export const CUSTOM_TEMPLATE_PATH = join(DATA_DIR, 'contracts', 'org-template.pdf');

// pdf-lib's 14 built-in StandardFonts only support WinAnsi encoding — they
// throw ("WinAnsi cannot encode...") on anything outside Latin-1, which
// includes Hebrew (shul name_he, a signer's typed Hebrew name, etc.), both
// very much expected input on this platform. Noto Sans Hebrew covers Basic
// Latin as well as Hebrew, so one pair of embedded fonts (regular/bold)
// handles every generated PDF and signature stamp instead of needing to
// detect script per line and switch fonts mid-string. Resolved relative to
// this file (not process.cwd()) since it's a bundled repo asset, not
// per-deployment DATA_DIR content.
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const HEBREW_FONT_BYTES = readFileSync(join(FONTS_DIR, 'NotoSansHebrew-Regular.ttf'));
const HEBREW_FONT_BOLD_BYTES = readFileSync(join(FONTS_DIR, 'NotoSansHebrew-Bold.ttf'));

// Registers fontkit (required for embedding non-standard/Unicode fonts) and
// embeds the regular+bold Hebrew-capable pair on a given PDFDocument. Each
// PDFDocument instance needs its own embed call.
async function embedUnicodeFonts(doc) {
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(HEBREW_FONT_BYTES);
  const bold = await doc.embedFont(HEBREW_FONT_BOLD_BYTES);
  return { font, bold };
}

export function hasCustomTemplate() { return existsSync(CUSTOM_TEMPLATE_PATH); }

// The admin-configured fillable fields for a document kind ('shul' |
// 'applicant' | 'store'), set via Settings > Documents' drag/resize editor
// (routes/settings.js). Returns [] if never configured, in which case
// stampSignatureFields() below falls back to a single hardcoded signature
// box in its original placement, so existing orgs see no change until they
// opt in.
//
// Storage format is an array of {id, type, label, x, y, width, height},
// coordinates as fractions (0-1) of the page, top-left origin. Older orgs
// have a single flat {x,y,width,height} object saved (the pre-multi-field
// format) — normalized here into a one-item 'signature' field so every
// caller only ever deals with the array shape.
export function getSignatureFields(orgId, kind) {
  const row = db.prepare('SELECT value FROM settings WHERE org_id = ? AND key = ?').get(orgId, `signature_box_${kind}`);
  if (!row) return [];
  const value = JSON.parse(row.value);
  if (Array.isArray(value)) return value;
  if (value && typeof value.x === 'number') return [{ id: 'signature', type: 'signature', label: 'Signature', x: value.x, y: value.y, width: value.width, height: value.height }];
  return [];
}

// Shared simple word-wrapping PDF body builder, used by both the shul
// contract and the generic applicant/store document generator below.
async function buildSimplePdf({ heading, subheading, fieldLines, bodyText }) {
  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]);
  const { font, bold } = await embedUnicodeFonts(doc);
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

// Normalizes a sign request body into a {values, missing} pair against a
// document's configured fields. Accepts either the new multi-field shape
// (`values: {fieldId: value}`) or the older single-signature shape
// (`signature_data`, still sent by apply.html's embedded contract-sign step
// and any other caller that hasn't been updated to the field editor) — a
// bare `signature_data` is applied to the first 'signature' field so those
// callers keep working unchanged against an org that never added extra
// fields. `missing` lists the labels of any required field left unfilled.
export function resolveSignatureValues(fields, body) {
  const values = { ...(body?.values || {}) };
  if (body?.signature_data) {
    const primary = fields.find(f => f.type === 'signature') || fields[0];
    if (primary && !values[primary.id]) values[primary.id] = body.signature_data;
  }
  const missing = fields.filter(f => f.required !== false && !values[f.id]).map(f => f.label || f.type);
  return { values, missing };
}

// Stamps one or more fillable fields onto the unsigned PDF: signature/initial
// images (or a typed-name fallback), plus plain typed text for 'date'/'text'
// fields — each at its own admin-configured position, optionally on its own
// page. `shulId` is really just "output file id" — callers for
// applicant/store documents pass a composite string like `applicant-<id>`
// here; the function itself has no shul-specific logic.
//
// `fields` comes from getSignatureFields() above: [{id, type, label, x, y,
// width, height, page}], coordinates as fractions 0-1 of the page, top-left
// origin — matches the drag/resize editor in the admin UI. `page` is a
// 0-based page index; omitted/out-of-range means "last page". Falls back to
// a single hardcoded signature box in the original "~16% up from the
// bottom-left" placement when no fields have been configured yet for this
// document kind, so existing orgs see no change until they opt in.
//
// `values` maps field id -> the signer's input: a `data:image/png;base64,`
// string for a drawn signature/initial, or plain text (typed name fallback
// for signature/initial, or the entered value for date/text fields).
// `signerName`/`signedAt`/`ip` are recorded once, below the *first*
// signature-type field, for the human-readable "Signed by / Date / IP" line
// that every signed document has always shown.
export async function stampSignatureFields({ unsignedPath, shulId, fields, values, signerName, signedAt, ip }) {
  const bytes = readFileSync(unsignedPath);
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const { font, bold } = await embedUnicodeFonts(doc);

  const effectiveFields = fields && fields.length ? fields : [{ id: 'signature', type: 'signature' }];
  let metaDrawn = false;

  for (const field of effectiveFields) {
    const pageIndex = (typeof field.page === 'number' && field.page >= 0 && field.page < pages.length) ? field.page : pages.length - 1;
    const page = pages[pageIndex];
    const { width: pw, height: ph } = page.getSize();

    let boxX, boxBottom, boxW, boxH;
    if ([field.x, field.y, field.width, field.height].every(v => typeof v === 'number' && v >= 0 && v <= 1)) {
      boxX = field.x * pw;
      boxW = Math.max(60, field.width * pw);
      boxH = Math.max(40, field.height * ph);
      boxBottom = ph - field.y * ph - boxH; // convert top-left-origin fraction to PDF's bottom-left points
    } else {
      const margin = Math.max(32, pw * 0.09);
      boxX = margin;
      boxW = Math.min(260, pw - margin * 2);
      boxH = Math.max(100, ph * 0.22);
      boxBottom = Math.max(60, ph * 0.16);
    }
    boxBottom = Math.max(10, boxBottom);
    const boxTop = boxBottom + boxH;
    const value = values?.[field.id];

    if (field.type === 'date' || field.type === 'text') {
      const label = field.type === 'date' ? (value || signedAt || '') : (value || '');
      page.drawText(String(label), { x: boxX, y: boxBottom + boxH * 0.3, size: Math.min(12, boxH * 0.5), font, color: rgb(0.15, 0.11, 0.09) });
      continue;
    }

    // signature | initial
    const isPrimarySignature = field.type === 'signature' && !metaDrawn;
    const lineY = boxTop - boxH * 0.06;
    page.drawLine({ start: { x: boxX, y: lineY }, end: { x: boxX + boxW, y: lineY }, thickness: 1, color: rgb(0.3, 0.25, 0.2) });
    const drawAreaH = boxH * (isPrimarySignature ? 0.48 : 0.8);
    if (value && value.startsWith('data:image/png;base64,')) {
      const pngBytes = Buffer.from(value.split(',')[1], 'base64');
      const png = await doc.embedPng(pngBytes);
      const scale = Math.min(boxW / png.width, drawAreaH / png.height, 1);
      const dims = png.scale(scale);
      page.drawImage(png, { x: boxX, y: lineY - 4 - dims.height, width: dims.width, height: dims.height });
    } else {
      page.drawText(value || signerName || '', { x: boxX + 4, y: lineY - drawAreaH * 0.65, size: Math.min(20, drawAreaH * 0.55), font: bold, color: rgb(0.15, 0.11, 0.09) });
    }

    if (isPrimarySignature) {
      metaDrawn = true;
      const lineGap = Math.max(9, boxH * 0.13);
      let textY = boxBottom + boxH * 0.4;
      page.drawText(`Signed by: ${signerName || ''}`, { x: boxX, y: textY, size: 10, font });
      textY = Math.max(boxBottom, textY - lineGap);
      page.drawText(`Date: ${signedAt}`, { x: boxX, y: textY, size: 9, font, color: rgb(0.4, 0.35, 0.3) });
      textY = Math.max(boxBottom - 4, textY - lineGap * 0.85);
      page.drawText(`IP: ${ip || 'n/a'}`, { x: boxX, y: textY, size: 8, font, color: rgb(0.5, 0.45, 0.4) });
    }
  }

  const outBytes = await doc.save();
  const outPath = join(DATA_DIR, 'contracts', `${shulId}-signed.pdf`);
  writeFileSync(outPath, outBytes);
  return outPath;
}
