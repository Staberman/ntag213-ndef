/**
 * Chromium `DOMException` → a typed error, with the ambiguity preserved.
 *
 * Chromium's chain, verified end to end:
 *
 *   `ndef_reader.cc`   NOT_ALLOWED         → NotAllowedError
 *                      NOT_SUPPORTED       → NotSupportedError
 *                      NOT_READABLE        → NotReadableError
 *                      INVALID_MESSAGE     → SyntaxError   (the spec says
 *                                            TypeError; both names are accepted
 *                                            here because Blink and the spec
 *                                            disagree and a Chromium TODO is open)
 *                      OPERATION_CANCELLED → AbortError
 *                      IO_ERROR            → NetworkError
 *
 * ## The one that cannot be resolved, and must not be pretended away
 *
 * `NfcService.ndefWrite()` does `if (tag.writeNdef(bytes)) return SUCCESS; else
 * return ErrorCodes.ERROR_IO;` — a tag that is already read-only, a tag that is
 * too small, and a tag that left the field mid-write all return the SAME code.
 * `Ndef.writeNdefMessage()` then throws a bare `IOException` with no message,
 * and `NfcImpl` concatenates `e.getMessage()`, which is `null`. What reaches
 * JavaScript is literally `"Failed to write due to an IO error: null"`.
 *
 * So `io_ambiguous` carries `ambiguous: true`, and the right answer to a failed
 * write is not a better error message — it is a READ, which is the only thing
 * that can actually tell the three causes apart.
 *
 * ## The two `NotAllowedError`s
 *
 * The permission refusal and the `overwrite:false` refusal share a name and are
 * separated only by their message. That separation is load-bearing: one means
 * "this origin is dead until the user changes a Chrome setting" and the other
 * means "this card is not blank". Treating them alike either hides a blocked
 * permission or accuses a working phone of holding a used card.
 */

export type TagOperationErrorCode =
  /** `NotAllowedError` with the permission message. Chrome will not re-ask. */
  | 'permission_denied'
  /** `NotAllowedError` from `overwrite:false` — the tag was not blank. */
  | 'not_blank'
  /** `NotReadableError` — "NFC setting is disabled." on the phone. */
  | 'nfc_disabled'
  /** `NotSupportedError` — MIFARE Classic, 125 kHz, a clone. */
  | 'tag_not_supported'
  /** `AbortError` — screen off, app switched, or your own timeout firing. */
  | 'suspended'
  /** `InvalidStateError` — running in an iframe. Web NFC needs top level. */
  | 'not_top_level'
  /** `SyntaxError` / `TypeError` — the message you built was rejected. */
  | 'invalid_message'
  /** A timeout you imposed. */
  | 'timeout'
  /** `NetworkError`. Three causes, indistinguishable. See above. */
  | 'io_ambiguous'
  /** Anything else. */
  | 'unknown';

export interface TagOperationError {
  readonly code: TagOperationErrorCode;
  /** The `DOMException.name` as observed, kept verbatim for the report. */
  readonly name: string;
  readonly message: string;
  /** True when the cause cannot be determined. Drives what you may tell the user. */
  readonly ambiguous: boolean;
}

/** Chromium's own string when `overwrite:false` meets a tag that has a message. */
const OVERWRITE_MARKER = 'overwrite';
/** Chromium's own string when the permission prompt is refused or blocked. */
const PERMISSION_MARKER = 'permission';

export interface DomExceptionLike {
  readonly name: string;
  readonly message: string;
}

/** True for a thrown value that looks enough like a `DOMException` to classify. */
export function isDomExceptionLike(value: unknown): value is DomExceptionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function codeFor(name: string, message: string): TagOperationErrorCode {
  const lower = message.toLowerCase();

  switch (name) {
    case 'NotAllowedError':
      if (lower.includes(OVERWRITE_MARKER)) return 'not_blank';
      if (lower.includes(PERMISSION_MARKER)) return 'permission_denied';
      // Unknown NotAllowedError. Treated as a permission problem rather than a
      // tag problem, because the recovery for the wrong guess is harmless in
      // that direction and misleading in the other.
      return 'permission_denied';
    case 'NotReadableError':
      // `NfcImpl.checkIfReady()` raises this when the adapter exists and is
      // switched off ("NFC setting is disabled."). Any other NotReadableError is
      // still "this phone cannot read right now", and the instruction is the
      // same, so it is not split further.
      return 'nfc_disabled';
    case 'NotSupportedError':
      return 'tag_not_supported';
    case 'InvalidStateError':
      return 'not_top_level';
    case 'SyntaxError':
    case 'TypeError':
      return 'invalid_message';
    case 'AbortError':
      return 'suspended';
    case 'TimeoutError':
      return 'timeout';
    case 'NetworkError':
      return 'io_ambiguous';
    default:
      return 'unknown';
  }
}

export function mapTagOperationError(thrown: unknown): TagOperationError {
  if (!isDomExceptionLike(thrown)) {
    return {
      code: 'unknown',
      name: typeof thrown === 'string' ? 'Error' : 'Unknown',
      message: typeof thrown === 'string' ? thrown : String(thrown),
      ambiguous: false,
    };
  }

  const code = codeFor(thrown.name, thrown.message);
  return {
    code,
    name: thrown.name,
    message: thrown.message,
    // ONLY `io_ambiguous` is ambiguous, and it always is. This flag is what the
    // interface reads to decide whether it may name a cause.
    ambiguous: code === 'io_ambiguous',
  };
}

/**
 * The three causes of `io_ambiguous`, in the order worth trying them.
 *
 * Exported as data rather than baked into a sentence so that a test can assert
 * there are exactly three, and that none of them is ever presented as the answer.
 */
export const IO_AMBIGUOUS_CAUSES: readonly string[] = [
  'the tag moved out of the field before the write finished',
  'the tag is already locked',
  'the chip is smaller than it claims',
] as const;
