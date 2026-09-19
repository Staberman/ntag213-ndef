import { err, ok, type Result } from './result.js';
import { buildNtag213Layout } from './ndef.js';

/**
 * Deciding whether an NTAG213 you just "locked" is actually locked.
 *
 * ## Why this is not a one-liner
 *
 * Web NFC cannot read lock bytes — the specification puts low-level I/O out of
 * scope, and `NDEFReadingEvent` carries only `serialNumber` and `message`. So
 * the bytes come from a memory dump (NFC TagInfo by NXP is the usual source)
 * and someone types four numbers into your tool. A field that accepts any four
 * numbers is not a gate. This module states the EXPECTED values, computes the
 * verdict from the bits, and binds the reading to a card by requiring the UID
 * shown alongside them.
 *
 * ## The trap that makes perfect cards look broken
 *
 * Page 28h on an NTAG213 is **three** dynamic lock bytes plus one RFUI byte
 * that always reads `BDh`. The dynamic lock bytes cover pages 10h–27h. A small
 * NDEF payload lives in pages 04h–0Eh and is covered by the STATIC lock bytes
 * at page 02h.
 *
 * So a correct, fully locked card reads `00 00 00 BD` at page 28h. Anyone told
 * to "confirm the bits at 28h" reads three zeros on a perfect card, concludes
 * the lock did not take, and either leaves a batch unconfirmed or stops
 * checking altogether. Page 28h is therefore INFORMATIONAL here, with its
 * expected value printed, and the verdict rests on page 02h.
 *
 * ## What "locked" means here, exactly
 *
 * Every page that holds a byte of the payload is locked by a static lock bit.
 * Nothing else counts: the CC access nibble going `00h` → `0Fh` stops
 * NDEF-aware apps and **not** a raw Type-2 writer, so a card with a read-only
 * CC and unset lock bits gets the verdict `cc_only` and is named as still
 * rewritable.
 */

/** User memory starts at page 04h; the CC is page 03h. */
export const NTAG213_USER_MEMORY_START_PAGE = 0x04;
export const NTAG213_CAPABILITY_CONTAINER_PAGE = 0x03;
export const NTAG213_PAGE_SIZE_BYTES = 4;

/** Page 02h bytes 2–3 hold the static lock bits; page 28h holds the dynamic ones. */
export const NTAG213_STATIC_LOCK_PAGE = 0x02;
export const NTAG213_DYNAMIC_LOCK_PAGE = 0x28;

/** The CC access byte value that marks the tag read-only. */
export const NTAG213_CC_READ_ONLY = 0x0f;
export const NTAG213_CC_READ_WRITE = 0x00;

/**
 * Page 28h on a factory-fresh NTAG213 and on a correctly locked one alike:
 * three dynamic lock bytes at `00` and one RFUI byte that always reads `BDh`.
 */
export const NTAG213_DYNAMIC_LOCK_UNTOUCHED = Uint8Array.from([0x00, 0x00, 0x00, 0xbd]);
export const NTAG213_DYNAMIC_LOCK_RFUI_BYTE = 0xbd;

export type LockEvidenceErrorCode = 'uid_empty' | 'static_lock_length' | 'dynamic_lock_length' | 'byte_out_of_range';

export interface LockEvidenceError {
  readonly code: LockEvidenceErrorCode;
  readonly field: string;
  readonly received: string;
}

/** What gets copied out of a memory dump. */
export interface LockEvidence {
  /** The tag UID. This is what binds the reading to a card. */
  readonly uid: string;
  /** Page 02h, bytes 2 and 3. */
  readonly staticLock: readonly [number, number];
  /** Page 03h, byte 3 — the CC access byte. */
  readonly capabilityContainerAccess: number;
  /** Page 28h, all four bytes. */
  readonly dynamicLock: readonly [number, number, number, number];
}

export const LOCK_CHECKS = [
  /** Every page holding a byte of the payload has its static lock bit set. */
  'static_lock_covers_payload',
  /** The CC access byte reads `0Fh`. Necessary, nowhere near sufficient. */
  'capability_container_read_only',
  /** Page 03h itself is locked, so the CC cannot be flipped back. */
  'capability_container_page_locked',
  /** Page 28h is as expected. Informational: it covers pages a small payload never reaches. */
  'dynamic_lock_as_expected',
] as const;

export type LockCheckName = (typeof LOCK_CHECKS)[number];

export interface LockCheck {
  readonly name: LockCheckName;
  readonly passed: boolean;
  /** False when a failure does not by itself mean the card is unlocked. */
  readonly decisive: boolean;
  readonly expected: string;
  readonly found: string;
}

export type LockVerdict =
  /** Every page of the payload is locked by a real static lock bit. */
  | 'locked'
  /**
   * The CC says read-only and the lock bits are not set. NDEF-aware apps refuse
   * to write; a raw Type-2 writer does not.
   */
  | 'cc_only'
  /** Neither. Nothing took. */
  | 'not_locked';

export interface LockReport {
  readonly verdict: LockVerdict;
  /** True only for `locked`. */
  readonly locked: boolean;
  readonly uid: string;
  /** Pages that must be locked for this payload, low to high. */
  readonly requiredPages: readonly number[];
  readonly unlockedPages: readonly number[];
  readonly checks: readonly LockCheck[];
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function hexBytes(values: readonly number[]): string {
  return values.map(hex).join(' ');
}

/**
 * The pages a URI field's layout occupies, derived from the layout itself.
 *
 * Derived and not written down, because a small payload fitting inside the
 * static lock range is luck, not design, and it breaks the moment the URI grows
 * or a second record is added. When that happens this returns pages past 0Fh,
 * the static lock bits cannot cover them, and `verifyLockEvidence` reports them
 * unlocked instead of silently approving a half-locked card.
 */
export function payloadPages(uriField: string): readonly number[] {
  const layout = buildNtag213Layout(uriField);
  if (!layout.ok) return [];
  const pageCount = Math.ceil(layout.value.length / NTAG213_PAGE_SIZE_BYTES);
  return Array.from({ length: pageCount }, (_unused, index) => NTAG213_USER_MEMORY_START_PAGE + index);
}

/**
 * Is `page` locked, given the two static lock bytes of page 02h?
 *
 * NTAG213 static lock byte layout (NXP NTAG213/215/216 datasheet):
 *   byte 2 — bit 0 BL-CC, bit 1 BL-9-4, bit 2 BL-15-10,
 *            bit 3 L-CC (page 03h), bits 4–7 L-4 … L-7
 *   byte 3 — bits 0–7 L-8 … L-15
 *
 * Pages above 0Fh have no static lock bit, so this returns false for them —
 * which is the correct answer and not an omission. Covering them needs the
 * dynamic lock bytes at page 28h, which most phone apps and Chrome's
 * `makeReadOnly()` do not touch.
 */
export function isPageStaticallyLocked(page: number, lockByte2: number, lockByte3: number): boolean {
  if (page === NTAG213_CAPABILITY_CONTAINER_PAGE) return (lockByte2 & 0b0000_1000) !== 0;
  if (page >= 0x04 && page <= 0x07) return (lockByte2 & (1 << page)) !== 0;
  if (page >= 0x08 && page <= 0x0f) return (lockByte3 & (1 << (page - 0x08))) !== 0;
  return false;
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

/**
 * Validates the shape of a reading before any of it is believed.
 *
 * An empty UID is rejected outright: without it the reading is not attached to
 * a card, and an unattached reading is how a perfectly good tag inherits the
 * lock confirmation that belonged to the previous one.
 */
export function parseLockEvidence(input: {
  readonly uid: string;
  readonly staticLock: readonly number[];
  readonly capabilityContainerAccess: number;
  readonly dynamicLock: readonly number[];
}): Result<LockEvidence, LockEvidenceError> {
  const uid = input.uid.trim().toLowerCase();
  if (uid === '') return err({ code: 'uid_empty', field: 'uid', received: input.uid });
  if (input.staticLock.length !== 2) {
    return err({ code: 'static_lock_length', field: 'staticLock', received: String(input.staticLock.length) });
  }
  if (input.dynamicLock.length !== 4) {
    return err({ code: 'dynamic_lock_length', field: 'dynamicLock', received: String(input.dynamicLock.length) });
  }
  for (const value of [...input.staticLock, input.capabilityContainerAccess, ...input.dynamicLock]) {
    if (!isByte(value)) return err({ code: 'byte_out_of_range', field: 'byte', received: String(value) });
  }

  const [lock0 = 0, lock1 = 0] = input.staticLock;
  const [dyn0 = 0, dyn1 = 0, dyn2 = 0, dyn3 = 0] = input.dynamicLock;

  return ok({
    uid,
    staticLock: [lock0, lock1],
    capabilityContainerAccess: input.capabilityContainerAccess,
    dynamicLock: [dyn0, dyn1, dyn2, dyn3],
  });
}

/**
 * Parses a hex dump the way a human retypes one: `04 1A 2B`, `04:1a:2b`,
 * `041a2b`, `0x04 0x1A`. Refuses anything that is not a whole number of bytes.
 */
export function parseHexBytes(text: string): readonly number[] | null {
  const cleaned = text.trim().toLowerCase().replaceAll('0x', '').replace(/[\s:,-]+/g, '');
  if (cleaned === '' || cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cleaned)) return null;

  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 2) {
    bytes.push(Number.parseInt(cleaned.slice(index, index + 2), 16));
  }
  return bytes;
}

/** Computes the verdict from a reading. No judgement is left to the UI. */
export function verifyLockEvidence(uriField: string, evidence: LockEvidence): LockReport {
  const [lockByte2, lockByte3] = evidence.staticLock;
  const requiredPages = payloadPages(uriField);
  const unlockedPages = requiredPages.filter((page) => !isPageStaticallyLocked(page, lockByte2, lockByte3));

  const staticCheck: LockCheck = {
    name: 'static_lock_covers_payload',
    passed: requiredPages.length > 0 && unlockedPages.length === 0,
    decisive: true,
    expected: `pages ${hex(requiredPages[0] ?? 0)}h-${hex(requiredPages[requiredPages.length - 1] ?? 0)}h locked`,
    found: unlockedPages.length === 0 ? 'all locked' : `unlocked: ${unlockedPages.map((page) => `${hex(page)}h`).join(', ')}`,
  };

  const ccAccessCheck: LockCheck = {
    name: 'capability_container_read_only',
    passed: evidence.capabilityContainerAccess === NTAG213_CC_READ_ONLY,
    decisive: false,
    expected: `${hex(NTAG213_CC_READ_ONLY)}h`,
    found: `${hex(evidence.capabilityContainerAccess)}h`,
  };

  const ccPageLocked = isPageStaticallyLocked(NTAG213_CAPABILITY_CONTAINER_PAGE, lockByte2, lockByte3);
  const ccPageCheck: LockCheck = {
    name: 'capability_container_page_locked',
    passed: ccPageLocked,
    decisive: false,
    expected: 'L-CC = 1',
    found: ccPageLocked ? 'L-CC = 1' : 'L-CC = 0',
  };

  const dynamicCheck: LockCheck = {
    name: 'dynamic_lock_as_expected',
    passed: evidence.dynamicLock[3] === NTAG213_DYNAMIC_LOCK_RFUI_BYTE && evidence.dynamicLock.slice(0, 3).every((byte) => byte === 0x00),
    decisive: false,
    expected: hexBytes([...NTAG213_DYNAMIC_LOCK_UNTOUCHED]),
    found: hexBytes([...evidence.dynamicLock]),
  };

  const verdict: LockVerdict = staticCheck.passed ? 'locked' : ccAccessCheck.passed ? 'cc_only' : 'not_locked';

  return {
    verdict,
    locked: verdict === 'locked',
    uid: evidence.uid,
    requiredPages,
    unlockedPages,
    checks: [staticCheck, ccAccessCheck, ccPageCheck, dynamicCheck],
  };
}
