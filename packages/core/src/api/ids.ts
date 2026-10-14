// Job IDs (API_CONVENTIONS §6): 8 Crockford base32 characters, shown as
// `7K2M-9QXA`. Players type them, so input is forgiving: any case, optional
// hyphen or spaces, and I/L/O read as 1/1/0.

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Canonical form (8 uppercase characters, no hyphen), or null if it can't be a job ID. */
export function parseJobId(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CROCKFORD.test(s) ? s : null;
}

/** Display form: `7K2M-9QXA`. Accepts any input `parseJobId` accepts; anything else is returned unchanged. */
export function formatJobId(id: string): string {
  const canonical = parseJobId(id);
  return canonical ? `${canonical.slice(0, 4)}-${canonical.slice(4)}` : id;
}
