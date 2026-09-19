import { err, ok, type Result } from './result.js';

/**
 * The NDEF byte layout an NTAG213 needs for **iOS background tag reading** to
 * work at all.
 *
 * The failure mode here is silent and iPhone-only: the tag reads perfectly on
 * Android, and an iPhone simply does nothing when it touches it. There is no
 * error, anywhere. Every constant below is load-bearing:
 *
 *   - TNF must be `001` (well known) with type `'U'`. `TNF_ABSOLUTE_URI` (0x03)
 *     reads fine in every Android app, and iOS background reading does NOTHING
 *     with it.
 *   - The URI record must be record 0, and the message must contain exactly one
 *     record. iOS reads only the first URI record; a leading Text record or an
 *     Android Application Record kills background reading with no error.
 *   - Identifier byte `04` means `https://`. Anything else is either a custom
 *     scheme — which leaves the card inert on iPhone — or wasted bytes.
 *
 * These functions are pure: they take a string and return bytes. Nothing here
 * touches hardware, so the byte-for-byte assertions in the tests need no tag.
 */

/** NDEF record header: MB=1, ME=1, CF=0, SR=1, IL=0, TNF=001 (well known). */
export const NDEF_RECORD_HEADER = 0xd1;
/** Type length: one byte. */
export const NDEF_TYPE_LENGTH = 0x01;
/** Type `'U'`, the well-known URI record type. */
export const NDEF_TYPE_URI = 0x55;
/** URI identifier code 0x04 = `https://`. */
export const NDEF_URI_IDENTIFIER_HTTPS = 0x04;
/**
 * The characters identifier byte `04` stands in for.
 *
 * Web NFC hands a reader back the URL with this prefix ALREADY EXPANDED — the
 * identifier byte is consumed by Chromium's parser and never reaches
 * JavaScript. A read-back verifier therefore has to strip it again to recover
 * the URI field, and it should strip exactly this string, from this constant,
 * so that the encoder and the verifier can never disagree about what `04` means.
 */
export const NDEF_URI_IDENTIFIER_HTTPS_PREFIX = 'https://';
/** Type 2 Tag TLV: NDEF Message. */
export const TLV_NDEF_MESSAGE = 0x03;
/** Type 2 Tag TLV: Terminator. */
export const TLV_TERMINATOR = 0xfe;

/**
 * The Lock Control TLV an NTAG213 carries PRE-WRITTEN at page 04h when it
 * leaves the factory. You do not write it; it is included in the full layout
 * because it is what makes the total 43 bytes rather than 38, and because a
 * read-back of user memory sees it.
 */
export const NTAG213_LOCK_CONTROL_TLV = Uint8Array.from([0x01, 0x03, 0xa0, 0x0c, 0x34]);

/** NTAG213's Capability Container declares a 144-byte NDEF area (CC byte 2 = 0x12). */
export const NTAG213_NDEF_CAPACITY_BYTES = 144;

/**
 * The ceiling on URI bytes after the `https://` prefix on an NTAG213:
 * 144 − 5 (lock control TLV) − 2 (TLV tag + length) − 1 (terminator)
 *     − 4 (record header, type length, payload length, type) − 1 (identifier).
 */
export const NTAG213_MAX_URI_BYTES = 131;

/**
 * A single-byte payload-length field only works up to 255 bytes; past that the
 * record needs the long format and the whole layout changes. An NTAG213 never
 * comes close, and the guard exists so that "the URI grew" fails loudly instead
 * of emitting a malformed record.
 */
const SHORT_RECORD_MAX_PAYLOAD = 0xff;

export type NdefErrorCode =
  /** The URI field contains a byte outside US-ASCII. */
  | 'uri_not_ascii'
  /** The URI field does not fit the tag's declared NDEF area. */
  | 'uri_exceeds_tag_capacity'
  /** The payload no longer fits a short record. */
  | 'payload_exceeds_short_record';

export interface NdefError {
  readonly code: NdefErrorCode;
  readonly uriField: string;
  readonly byteLength: number;
  readonly byteLimit: number;
}

/**
 * The URI field must be plain US-ASCII. This guard exists so that a non-ASCII
 * host or path fails here rather than producing a record whose declared length
 * disagrees with its bytes.
 */
function asciiBytes(text: string): Uint8Array | null {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    if (codePoint > 0x7f) return null;
    bytes[index] = codePoint;
  }
  return bytes;
}

/**
 * Byte counts of the layout, named so that a read-back report can account for
 * every byte instead of asserting a total.
 *
 * Record framing is `D1 01 <payload length> 55` plus the identifier byte `04` —
 * five bytes in front of the URI field. Of those five, three (`D1`, `01`, `55`)
 * are DERIVABLE from what a Web NFC read returns, and two (the payload length
 * and the identifier) are only INFERABLE, because Chromium expands the prefix
 * and reports neither.
 */
export const NDEF_DERIVABLE_HEADER_BYTES = 3;
export const NDEF_INFERRED_HEADER_BYTES = 2;
/** `03 <length>` in front of the message and `FE` behind it. */
export const NDEF_TLV_FRAMING_BYTES = 3;

/**
 * The NDEF message for a URI field: exactly one well-known URI record, nothing
 * else. `D1 01 <payload length> 55 04 <uri bytes>`.
 *
 * `uriField` is everything after `https://` — the identifier byte carries the
 * prefix, so pass `example.com/x`, not `https://example.com/x`.
 */
export function buildNdefMessage(uriField: string): Result<Uint8Array, NdefError> {
  const uriBytes = asciiBytes(uriField);

  if (uriBytes === null) {
    return err({ code: 'uri_not_ascii', uriField, byteLength: uriField.length, byteLimit: NTAG213_MAX_URI_BYTES });
  }

  if (uriBytes.length > NTAG213_MAX_URI_BYTES) {
    return err({ code: 'uri_exceeds_tag_capacity', uriField, byteLength: uriBytes.length, byteLimit: NTAG213_MAX_URI_BYTES });
  }

  // Payload = the URI identifier byte plus the URI field.
  const payloadLength = uriBytes.length + 1;
  if (payloadLength > SHORT_RECORD_MAX_PAYLOAD) {
    return err({ code: 'payload_exceeds_short_record', uriField, byteLength: payloadLength, byteLimit: SHORT_RECORD_MAX_PAYLOAD });
  }

  const message = new Uint8Array(4 + payloadLength);
  message[0] = NDEF_RECORD_HEADER;
  message[1] = NDEF_TYPE_LENGTH;
  message[2] = payloadLength;
  message[3] = NDEF_TYPE_URI;
  message[4] = NDEF_URI_IDENTIFIER_HTTPS;
  message.set(uriBytes, 5);

  return ok(message);
}

/**
 * The NDEF Message TLV as written into user memory: `03 <length> <message> FE`.
 */
export function buildNdefTlvBlock(uriField: string): Result<Uint8Array, NdefError> {
  const message = buildNdefMessage(uriField);
  if (!message.ok) return message;

  const block = new Uint8Array(message.value.length + NDEF_TLV_FRAMING_BYTES);
  block[0] = TLV_NDEF_MESSAGE;
  block[1] = message.value.length;
  block.set(message.value, 2);
  block[block.length - 1] = TLV_TERMINATOR;

  return ok(block);
}

/**
 * The full picture of NTAG213 user memory from page 04h: the factory Lock
 * Control TLV, then the NDEF Message TLV, then the terminator.
 *
 * This is what a read-back compares against, and what makes "43 of 144 bytes"
 * checkable rather than asserted.
 */
export function buildNtag213Layout(uriField: string): Result<Uint8Array, NdefError> {
  const block = buildNdefTlvBlock(uriField);
  if (!block.ok) return block;

  const layout = new Uint8Array(NTAG213_LOCK_CONTROL_TLV.length + block.value.length);
  layout.set(NTAG213_LOCK_CONTROL_TLV, 0);
  layout.set(block.value, NTAG213_LOCK_CONTROL_TLV.length);

  return ok(layout);
}

/** Uppercase hex, space separated — for showing expected vs found bytes. */
export function toHexDump(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
