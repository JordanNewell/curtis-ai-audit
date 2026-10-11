/**
 * Brand mark for the ribbon and settings header. Geometry is traced from
 * assets/curtis-ai-logo.png; keep the two in sync when the brand updates.
 * Fixed brand green (#0E7A45) rather than currentColor so the mark stays
 * recognizable across light/dark themes.
 */
export const CURTIS_MARK_ICON_ID = "curtis-ai-mark";

export const CURTIS_MARK_SVG =
  '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#0E7A45" d="M 855.3 275.1 A 417.5 417.5 0 1 0 855.3 747.9 ' +
  "C 872.6 707.8 869.8 676.9 770 630.3 A 284.5 284.5 0 1 1 770 392.7 " +
  'C 869.8 346.1 872.6 315.2 855.3 275.1 Z"/>' +
  '<path d="M 690 515.7 L 737.5 563 L 831 462" fill="none" stroke="#0E7A45" ' +
  'stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/></svg>';
