// Normalizes any phone number input (dashes, dots, spaces, parens, an
// optional leading US country code "1") down to the canonical display
// format "123-456-7890" used everywhere in the system. Anything that isn't
// a recognizable 10-digit US number is left as the caller's trimmed input
// rather than corrupted/dropped, since not every phone field is required.
export function normalizePhone(raw) {
  if (raw === undefined || raw === null) return raw;
  const str = String(raw).trim();
  if (!str) return '';
  let digits = str.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return str;
}
