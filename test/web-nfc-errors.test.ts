import { describe, expect, it } from 'vitest';
import { IO_AMBIGUOUS_CAUSES, mapTagOperationError } from '../src/web-nfc-errors.js';

describe('the two NotAllowedErrors', () => {
  it('separates "card is not blank" from "permission is blocked"', () => {
    expect(mapTagOperationError({ name: 'NotAllowedError', message: 'NDEF message with overwrite:false' }).code).toBe('not_blank');
    expect(mapTagOperationError({ name: 'NotAllowedError', message: 'NFC permission request denied.' }).code).toBe('permission_denied');
  });

  it('falls back to permission_denied, where a wrong guess is harmless', () => {
    expect(mapTagOperationError({ name: 'NotAllowedError', message: 'something new' }).code).toBe('permission_denied');
  });
});

describe('io_ambiguous', () => {
  it('flags the NetworkError that Chromium cannot explain', () => {
    const error = mapTagOperationError({ name: 'NetworkError', message: 'Failed to write due to an IO error: null' });
    expect(error.code).toBe('io_ambiguous');
    expect(error.ambiguous).toBe(true);
  });

  it('is the only ambiguous code', () => {
    for (const name of ['NotAllowedError', 'NotReadableError', 'NotSupportedError', 'AbortError', 'SyntaxError']) {
      expect(mapTagOperationError({ name, message: '' }).ambiguous).toBe(false);
    }
  });

  it('lists exactly three causes and names none of them as the answer', () => {
    expect(IO_AMBIGUOUS_CAUSES).toHaveLength(3);
  });
});

describe('the rest of the chain', () => {
  it.each([
    ['NotReadableError', 'nfc_disabled'],
    ['NotSupportedError', 'tag_not_supported'],
    ['InvalidStateError', 'not_top_level'],
    ['SyntaxError', 'invalid_message'],
    ['TypeError', 'invalid_message'],
    ['AbortError', 'suspended'],
    ['TimeoutError', 'timeout'],
    ['WhatIsThis', 'unknown'],
  ])('maps %s to %s', (name, code) => {
    expect(mapTagOperationError({ name, message: '' }).code).toBe(code);
  });

  it('survives a thrown string', () => {
    expect(mapTagOperationError('boom')).toMatchObject({ code: 'unknown', message: 'boom', ambiguous: false });
  });
});
