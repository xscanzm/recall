# ADR 001: Conservative OCR Block Delta and Exact Reuse

**Status:** Accepted for implementation

**Date:** 2026-07-16

## Context

Historical Recall screenshots showed that OCR on original images preserves selected key text at 90.8%, while OCR after the current 800px q45 compression falls to 26.4%. Global grayscale, sharpening, inversion, and contrast do not improve the overall result. Whole-image similarity also produces opposing cases: a 99.8% similar Codex frame contains meaningful new input, while a 99.998% similar Terminal frame changes only its cursor.

## Decision

Use decoded pixel equality as the only condition that skips OCR or an in-batch model frame. For all other images, run OCR and compare structured text blocks. Send a full structured OCR baseline once per submitted window sequence and block-level changes afterward. Store complete OCR evidence locally with each L0 observation. Commit frame cache state only after durable batch creation.

## Alternatives

1. Whole-image pHash/SSIM threshold: rejected because it loses meaningful small-region changes.
2. Global image preprocessing: rejected because historical screenshots show mixed or negative accuracy changes.
3. Replace Windows OCR immediately: rejected until a candidate engine beats it on the same Recall ground-truth set.
4. Accessibility Tree as the primary source: deferred because it does not cover all applications and changes the capture boundary substantially.

## Consequences

- Exact duplicates reduce OCR work and in-batch image/output tokens safely.
- Near duplicates still pay OCR cost, but repeated OCR prompt text is reduced.
- L0 storage grows because it includes structured local OCR evidence.
- Windows OCR confidence is unavailable; consumers must treat missing confidence honestly.
- Block matching is deliberately conservative, favoring extra model evidence over lost text.

