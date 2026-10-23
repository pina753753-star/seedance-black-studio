'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReferenceDanceProbe } = require('../watermark-server/reference-dance-inspection.js');
const { referenceDanceCredits } = require('../api/_lib/reference-dance.js');
function probe(duration) {
  return validateReferenceDanceProbe({ format: { format_name: 'mov,mp4', duration }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }
  ] });
}
for (const [seconds, milliseconds, billableSeconds, credits] of [
  [4, 4000, 4, 165], [5, 5000, 5, 205], [5.000333, 5001, 6, 245],
  [14.999999, 15000, 15, 605], [15, 15000, 15, 605]
]) {
  test(`duration ${seconds}s retains its exact ceiling-second billing`, () => {
    const metadata = probe(seconds);
    assert.equal(metadata.durationMs, milliseconds);
    assert.equal(Math.ceil(metadata.durationMs / 1000), billableSeconds);
    assert.equal(referenceDanceCredits(billableSeconds), credits);
  });
}
test('duration limits use exact seconds, not rounded milliseconds', () => {
  assert.throws(() => probe(3.999999), /VIDEO_DURATION_INVALID/);
  assert.throws(() => probe(15.000001), /VIDEO_DURATION_INVALID/);
});
