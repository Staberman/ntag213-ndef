import { describe, expect, it } from 'vitest';
import {
  isPageStaticallyLocked,
  parseHexBytes,
  parseLockEvidence,
  payloadPages,
  verifyLockEvidence,
  type LockEvidence,
} from '../src/lock.js';

const URI = 'example.com/x';

/** Pages 04h-0Ah locked (bits 4-7 of byte 2, bits 0-2 of byte 3) plus L-CC. */
const LOCKED: LockEvidence = {
  uid: '04a1b2c3d4e5f6',
  staticLock: [0xf8, 0x07],
  capabilityContainerAccess: 0x0f,
  dynamicLock: [0x00, 0x00, 0x00, 0xbd],
};

describe('the page 28h trap', () => {
  it('calls a correctly locked card LOCKED even though page 28h reads 00 00 00 BD', () => {
    // This is the whole point of the module. Page 28h holds three dynamic lock
    // bytes covering pages 10h-27h, which a short payload never reaches, plus an
    // RFUI byte that always reads BDh. Anyone checking 28h sees three zeros on a
    // perfect card and concludes the lock failed.
    const report = verifyLockEvidence(URI, LOCKED);
    expect(report.verdict).toBe('locked');
    expect(report.locked).toBe(true);
    expect(report.unlockedPages).toEqual([]);
  });

  it('treats page 28h as informational, never decisive', () => {
    const check = verifyLockEvidence(URI, LOCKED).checks.find((c) => c.name === 'dynamic_lock_as_expected');
    expect(check?.decisive).toBe(false);
    expect(check?.passed).toBe(true);
  });

  it('never lets page 28h decide anything', () => {
    const decisive = verifyLockEvidence(URI, LOCKED).checks.filter((c) => c.decisive);
    expect(decisive.map((c) => c.name)).toEqual(['payload_fits_tag', 'static_lock_covers_payload']);
    expect(decisive.map((c) => c.name)).not.toContain('dynamic_lock_as_expected');
  });
});

describe('verdicts', () => {
  it('reports cc_only when the CC says read-only but no lock bit is set', () => {
    // NDEF-aware apps refuse to write. A raw Type-2 writer does not.
    const report = verifyLockEvidence(URI, { ...LOCKED, staticLock: [0x00, 0x00] });
    expect(report.verdict).toBe('cc_only');
    expect(report.locked).toBe(false);
  });

  it('reports not_locked when nothing took', () => {
    const report = verifyLockEvidence(URI, {
      ...LOCKED,
      staticLock: [0x00, 0x00],
      capabilityContainerAccess: 0x00,
    });
    expect(report.verdict).toBe('not_locked');
  });

  it('names the pages that are still open rather than just failing', () => {
    // byte 3 = 0x03 locks 08h and 09h but not 0Ah.
    // byte 3 = 0x03 locks 08h and 09h but not 0Ah. The CC still reads read-only,
    // so the honest verdict is cc_only: an NDEF app will refuse, a raw writer won't.
    const report = verifyLockEvidence(URI, { ...LOCKED, staticLock: [0xf8, 0x03] });
    expect(report.unlockedPages).toEqual([0x0a]);
    expect(report.verdict).toBe('cc_only');
    expect(report.locked).toBe(false);
  });
});

describe('payloadPages', () => {
  it('derives the pages from the layout, not from a hardcoded range', () => {
    expect(payloadPages(URI)).toEqual([0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]);
  });

  it('returns pages past 0Fh when the URI grows, so they report as unlocked', () => {
    const pages = payloadPages('example.com/' + 'a'.repeat(60));
    expect(pages.some((page) => page > 0x0f)).toBe(true);
    // Even with every static lock bit set, pages past 0Fh have none, so they
    // report unlocked and the card is never called locked.
    const report = verifyLockEvidence('example.com/' + 'a'.repeat(60), { ...LOCKED, staticLock: [0xff, 0xff] });
    expect(report.verdict).not.toBe('locked');
    expect(report.unlockedPages.every((page) => page > 0x0f)).toBe(true);
  });
});

describe('isPageStaticallyLocked', () => {
  it('maps page 03h to L-CC, bit 3 of lock byte 2', () => {
    expect(isPageStaticallyLocked(0x03, 0b0000_1000, 0x00)).toBe(true);
    expect(isPageStaticallyLocked(0x03, 0b0000_0000, 0x00)).toBe(false);
  });

  it('maps pages 04h-07h to bits 4-7 of lock byte 2', () => {
    expect(isPageStaticallyLocked(0x04, 0b0001_0000, 0x00)).toBe(true);
    expect(isPageStaticallyLocked(0x07, 0b1000_0000, 0x00)).toBe(true);
  });

  it('maps pages 08h-0Fh to lock byte 3', () => {
    expect(isPageStaticallyLocked(0x08, 0x00, 0b0000_0001)).toBe(true);
    expect(isPageStaticallyLocked(0x0f, 0x00, 0b1000_0000)).toBe(true);
  });

  it('says no for pages above 0Fh, which have no static lock bit at all', () => {
    expect(isPageStaticallyLocked(0x10, 0xff, 0xff)).toBe(false);
  });
});

describe('parseLockEvidence', () => {
  it('rejects an empty UID, so a reading cannot float free of a card', () => {
    const result = parseLockEvidence({ uid: '  ', staticLock: [0, 0], capabilityContainerAccess: 0, dynamicLock: [0, 0, 0, 0] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('uid_empty');
  });

  it('rejects a byte outside 0-255', () => {
    const result = parseLockEvidence({ uid: '04', staticLock: [0, 256], capabilityContainerAccess: 0, dynamicLock: [0, 0, 0, 0] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('byte_out_of_range');
  });
});

describe('parseHexBytes', () => {
  it('accepts the shapes a human actually retypes', () => {
    for (const text of ['04 1A 2B', '04:1a:2b', '041a2b', '0x04 0x1A 0x2B', '04-1a-2b']) {
      expect(parseHexBytes(text)).toEqual([0x04, 0x1a, 0x2b]);
    }
  });

  it('refuses a half byte', () => {
    expect(parseHexBytes('04 1')).toBeNull();
  });
});

describe('a payload the tag could never have held', () => {
  const TOO_LONG = 'a'.repeat(200);

  it('is never called locked, whatever the lock bytes say', () => {
    const report = verifyLockEvidence(TOO_LONG, { ...LOCKED, staticLock: [0xff, 0xff] });
    expect(report.verdict).toBe('not_locked');
    expect(report.locked).toBe(false);
  });

  it('says so, instead of reporting a nonsense page range', () => {
    const check = verifyLockEvidence(TOO_LONG, LOCKED).checks.find((c) => c.name === 'payload_fits_tag');
    expect(check).toMatchObject({ passed: false, decisive: true });
  });

  it('treats a non-ASCII URI the same way', () => {
    expect(verifyLockEvidence('ejemplo.com/ñ', { ...LOCKED, staticLock: [0xff, 0xff] }).verdict).toBe('not_locked');
  });

  it('still passes a URI that does fit', () => {
    expect(verifyLockEvidence(URI, LOCKED).checks.find((c) => c.name === 'payload_fits_tag')?.passed).toBe(true);
  });
});
