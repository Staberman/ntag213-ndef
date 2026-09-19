# ntag213-ndef

NDEF bytes that **iOS background tag reading actually accepts**, plus an NTAG213 lock verifier that reads the right page.

Zero dependencies. Pure functions in, bytes out — nothing here touches hardware, so all of it is testable without a tag.

```sh
npm install ntag213-ndef
```

## Why this exists

Two failures cost real money to learn, and neither announces itself.

### 1. The tag reads fine on Android and does nothing on an iPhone

iOS background reading — the thing that pops a notification when someone taps a tag with no app open — is far pickier than the NDEF spec. Get any of this wrong and there is **no error, anywhere**:

| Rule | Why |
|---|---|
| TNF must be `001` (well known) with type `'U'` | `TNF_ABSOLUTE_URI` (`0x03`) reads fine in every Android app and iOS does **nothing** with it |
| The URI record must be record 0, and alone | iOS reads only the first URI record; a leading Text record or an Android Application Record kills it |
| Identifier byte `04` = `https://` | Any custom scheme leaves the card inert on iPhone |

```ts
import { buildNdefMessage, toHexDump } from 'ntag213-ndef';

const message = buildNdefMessage('example.com/x'); // everything after https://
if (message.ok) {
  toHexDump(message.value);
  // D1 01 0E 55 04 65 78 61 6D 70 6C 65 2E 63 6F 6D 2F 78
  //  ^TNF 001, type 'U'    ^04 = https://
}
```

### 2. A perfectly locked card looks broken

Page `28h` on an NTAG213 is **three** dynamic lock bytes plus one RFUI byte that always reads `BDh`. The dynamic lock bytes cover pages `10h–27h`. A short URI lives in pages `04h–0Eh`, covered by the **static** lock bytes at page `02h`.

So a correct, fully locked card reads `00 00 00 BD` at page `28h`.

Anyone told to "confirm the bits at 28h" sees three zeros on a perfect card, concludes the lock failed, and either leaves a batch unconfirmed or quietly stops checking. This library treats `28h` as **informational**, prints its expected value, and rests the verdict on `02h`.

```ts
import { verifyLockEvidence } from 'ntag213-ndef';

const report = verifyLockEvidence('example.com/x', {
  uid: '04a1b2c3d4e5f6',
  staticLock: [0xf8, 0x07],          // page 02h, bytes 2-3
  capabilityContainerAccess: 0x0f,   // page 03h, byte 3
  dynamicLock: [0x00, 0x00, 0x00, 0xbd], // page 28h — the trap
});

report.verdict; // 'locked'
report.checks;  // four named checks, each with expected vs found
```

## Three verdicts, not a boolean

| Verdict | Meaning |
|---|---|
| `locked` | Every page holding a byte of the payload has its static lock bit set. |
| `cc_only` | The Capability Container reads `0Fh` but no lock bit is set. **NDEF-aware apps refuse to write; a raw Type-2 writer does not.** The card is still rewritable. |
| `not_locked` | Neither. Nothing took. |

### What `locked` guarantees, precisely

**Every page that holds a byte of *your* payload has its static lock bit set.** Not "the tag is immutable."

The NTAG213 address space is split, and both halves matter:

| Region | Locked by | Covers |
|---|---|---|
| Pages `03h`–`0Fh` | **static** lock bits, page `02h` | the CC plus the first 48 bytes of user memory |
| Pages `10h`–`27h` | **dynamic** lock bytes, page `28h` | the remaining 96 bytes, at 2-page granularity |

A short `https://` URI fits inside `04h`–`0Eh`, so the static bits cover all of it and page `28h` is irrelevant — which is exactly why a correct card reads `00 00 00 BD` there.

When the URI grows past page `0Fh`, static lock bits **cannot** reach it. `payloadPages()` derives the range from the layout rather than assuming it, those pages come back in `unlockedPages`, and the verdict is never `locked`:

```ts
payloadPages('example.com/' + 'a'.repeat(80));
// [0x04 … 0x0f, 0x10, 0x11 … 0x1e]   ← reaches past the static range

verifyLockEvidence(longUri, { ...evidence, staticLock: [0xff, 0xff] }).verdict;
// 'cc_only' — every static bit is set and it still refuses to say locked
```

If you need pages above `0Fh` genuinely locked, you must set the dynamic lock bytes yourself; most phone apps and Chrome's `makeReadOnly()` do not touch them.

`cc_only` is the one people miss. Chrome's `makeReadOnly()` and most phone apps flip the CC and leave the lock bits alone, which looks locked to every tool that asks politely.

The required pages are **derived from the layout**, not hardcoded — so when a URI grows past page `0Fh`, where no static lock bit exists, those pages report unlocked instead of being silently approved.

## Web NFC errors, with the ambiguity kept

`NfcService.ndefWrite()` returns `ERROR_IO` when a tag is already read-only, when it is too small, **and** when it left the field mid-write. `Ndef.writeNdefMessage()` throws a bare `IOException`, so what reaches JavaScript is literally `"Failed to write due to an IO error: null"`.

```ts
import { mapTagOperationError, IO_AMBIGUOUS_CAUSES } from 'ntag213-ndef';

const error = mapTagOperationError(thrown);
if (error.ambiguous) {
  // Three possible causes and no way to tell them apart. Do not guess —
  // the only thing that resolves it is a READ.
  IO_AMBIGUOUS_CAUSES; // exactly three, none of them "the" answer
}
```

It also separates the two `NotAllowedError`s, which share a name and mean opposite things: a blocked permission (this origin is dead until a Chrome setting changes) versus `overwrite:false` meeting a tag that is not blank.

## API

**NDEF** — `buildNdefMessage`, `buildNdefTlvBlock`, `buildNtag213Layout`, `toHexDump`, plus every byte constant.

**Lock** — `verifyLockEvidence`, `parseLockEvidence`, `payloadPages`, `isPageStaticallyLocked`, `parseHexBytes`.

**Web NFC** — `mapTagOperationError`, `isDomExceptionLike`, `IO_AMBIGUOUS_CAUSES`.

Every fallible function returns `Result<T, E>` — `{ ok: true, value }` or `{ ok: false, error }`. Nothing throws.

## Scope

Encoding and verification only. Reading and writing tags is your job — Web NFC in Chromium, or `nfc-pcsc` with a reader. Lock bytes cannot be read over Web NFC at all (the spec puts low-level I/O out of scope), so they come from a memory dump; NFC TagInfo by NXP is the usual source.

Written for NTAG213. The NDEF encoding applies to any Type 2 tag; the capacity constants and lock-bit map do not.

## License

MIT
