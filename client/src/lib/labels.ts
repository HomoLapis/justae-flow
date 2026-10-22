/**
 * After Effects label colors (index 1-16, AE's default order). Hex values are
 * approximations of AE's DEFAULT palette — used only for the UI swatch. The
 * placed layer is colored by INDEX (layer.label = index) so it always gets
 * AE's real color, even if the user customised the palette.
 */
const AE_LABEL_HEX: Record<number, string> = {
  1: '#e05c5c', 2: '#d8c84c', 3: '#6cc8d8', 4: '#e0a8c4',
  5: '#b0a4dc', 6: '#e0b48c', 7: '#a4d0b4', 8: '#5c6cdc',
  9: '#4ca04c', 10: '#9c5cc0', 11: '#e08c3c', 12: '#9c6c44',
  13: '#e04cb0', 14: '#4cc8c8', 15: '#c0ac84', 16: '#2c6c3c',
};

/** Hex swatch for an AE label index, or null for 0/None/unknown. */
export function shotLabelHex(labelIndex: number): string | null {
  return AE_LABEL_HEX[labelIndex] ?? null;
}
