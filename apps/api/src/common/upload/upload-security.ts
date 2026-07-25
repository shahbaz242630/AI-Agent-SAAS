/**
 * Upload security shared by every upload surface (BRD 15). Promoted from the
 * 1.3 imports module in Slice 1.4 (plan §3) so the CSV/Excel import and the
 * PDF invoice-document upload share the ONE malware-scan seam.
 */

/**
 * Malware-scan seam (BRD 15): a single hook in the upload path so a scanner
 * drops in later without route changes. Currently a no-op.
 */
export function scanUpload(_buffer: Buffer): void {
  // No-op until a malware scanner is integrated (BRD 15).
}
