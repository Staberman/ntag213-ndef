import { describe, expect, it } from 'vitest';
import {
  buildNdefMessage,
  buildNdefTlvBlock,
  buildNtag213Layout,
  toHexDump,
  NTAG213_MAX_URI_BYTES,
} from '../src/ndef.js';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('buildNdefMessage', () => {
  it('emits the exact bytes iOS background reading requires', () => {
    // D1 = MB+ME+SR+TNF(001). 01 = type length. 0E = payload. 55 = 'U'. 04 = https://
    expect(toHexDump(unwrap(buildNdefMessage('example.com/x')))).toBe(
      'D1 01 0E 55 04 65 78 61 6D 70 6C 65 2E 63 6F 6D 2F 78',
    );
  });

  it('uses TNF 001 well-known, never TNF 003 absolute-URI', () => {
    // 0xD1 & 0b111 === 1. TNF 003 reads fine on Android and does nothing on iPhone.
    expect(unwrap(buildNdefMessage('a.co'))[0]! & 0b111).toBe(1);
  });

  it('declares a payload length that matches the bytes that follow it', () => {
    const message = unwrap(buildNdefMessage('example.com/abc'));
    expect(message[2]).toBe(message.length - 4);
  });

  it('refuses a non-ASCII URI instead of emitting a mis-declared record', () => {
    const result = buildNdefMessage('ejemplo.com/ñ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('uri_not_ascii');
  });

  it('refuses a URI past the tag capacity', () => {
    const result = buildNdefMessage('a'.repeat(NTAG213_MAX_URI_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('uri_exceeds_tag_capacity');
  });

  it('accepts a URI exactly at the capacity', () => {
    expect(buildNdefMessage('a'.repeat(NTAG213_MAX_URI_BYTES)).ok).toBe(true);
  });
});

describe('buildNdefTlvBlock', () => {
  it('wraps the message in 03 <length> … FE', () => {
    const block = unwrap(buildNdefTlvBlock('example.com/x'));
    const message = unwrap(buildNdefMessage('example.com/x'));
    expect(block[0]).toBe(0x03);
    expect(block[1]).toBe(message.length);
    expect(block.at(-1)).toBe(0xfe);
    expect(block.length).toBe(message.length + 3);
  });
});

describe('buildNtag213Layout', () => {
  it('puts the factory lock control TLV in front', () => {
    expect(toHexDump(unwrap(buildNtag213Layout('a.co')).slice(0, 5))).toBe('01 03 A0 0C 34');
  });

  it('fits a typical short link in 43 bytes of the 144 available', () => {
    // 5 lock control + 3 TLV framing + 4 record header + 1 identifier + 30 uri
    expect(unwrap(buildNtag213Layout('example.com/abcdef?n=1')).length).toBe(35);
  });
});
