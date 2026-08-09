// Regression tests. Each case names the cross-check finding it locks down.
// Run: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCandidate, isWellFormed } from '../lib/gate.mjs';
import { renderSuccess, renderError } from '../lib/render.mjs';
import { countPublications } from '../lib/publications.mjs';
import { buildStatus, deriveBaseline } from '../lib/static-state.mjs';

const makeData = (total, selected) => {
    const data = { selected: Array.from({ length: selected }, (_, i) => ({ title: `sel-${i}` })) };
    data['2024'] = Array.from({ length: total }, (_, i) => ({ title: `pub-${i}` }));
    return data;
};

const HEALTHY = makeData(69, 40);
const BASELINE = { maxTotal: 69, maxSelected: 40 };

test('countPublications excludes the selected list', () => {
    assert.equal(countPublications(HEALTHY), 69);
});

test('healthy candidate passes', () => {
    assert.equal(evaluateCandidate(HEALTHY, HEALTHY, BASELINE).ok, true);
});

// Codex + Agy, High: the scraper degrading 40 -> 1 while DBLP stays healthy.
test('REGRESSION: selected collapse 40 -> 1 is rejected even when totals are intact', () => {
    const degraded = makeData(69, 1);
    const verdict = evaluateCandidate(degraded, HEALTHY, BASELINE);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /selected/);
});

test('REGRESSION: selected collapse 40 -> 19 is rejected', () => {
    const verdict = evaluateCandidate(makeData(69, 19), HEALTHY, BASELINE);
    assert.equal(verdict.ok, false);
});

test('empty selected is rejected', () => {
    assert.equal(evaluateCandidate(makeData(69, 0), HEALTHY, BASELINE).ok, false);
});

// Codex, High: ratios compare only to the previous run, so repeated halvings
// would each pass. High-water marks must stop the ratchet.
test('REGRESSION: cumulative collapse 69->35->18 is stopped by the high-water baseline', () => {
    // A single halving sits exactly on the 50% boundary and is allowed through:
    // relative-to-previous checks cannot distinguish it from real change.
    const step1 = makeData(35, 20);
    assert.equal(evaluateCandidate(step1, HEALTHY, BASELINE).ok, true);

    // The second halving is where a previous-only gate would silently ratchet
    // down. The high-water baseline must not drift, so this has to be rejected.
    const step2 = makeData(18, 10);
    const second = evaluateCandidate(step2, step1, BASELINE);
    assert.equal(second.ok, false);
    assert.match(second.reason, /high-water/);
});

test('REGRESSION: static builds persist and restore the high-water baseline', () => {
    const generatedAt = '2026-08-09T00:00:00.000Z';
    const firstStatus = buildStatus(HEALTHY, { maxTotal: 0, maxSelected: 0 }, generatedAt);
    assert.deepEqual(firstStatus.baseline, BASELINE);

    const step1 = makeData(35, 20);
    const restored = deriveBaseline(step1, firstStatus);
    assert.deepEqual(restored, BASELINE, 'a smaller accepted build must not lower the high-water marks');

    const step2 = makeData(18, 10);
    const verdict = evaluateCandidate(step2, step1, restored);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /high-water/);
});

// Both peers: a legitimate contraction must remain possible.
test('ALLOW_SHRINK overrides the gate for a genuine contraction', () => {
    const shrunk = makeData(20, 5);
    assert.equal(evaluateCandidate(shrunk, HEALTHY, BASELINE).ok, false);
    assert.equal(evaluateCandidate(shrunk, HEALTHY, BASELINE, { allowShrink: true }).ok, true);
});

test('rejection message tells the operator how to override', () => {
    const verdict = evaluateCandidate(makeData(69, 1), HEALTHY, BASELINE);
    assert.match(verdict.reason, /ALLOW_SHRINK=1/);
});

// Codex, Medium: loadFromDisk previously trusted the file's shape.
test('REGRESSION: structural check rejects a malformed or hand-edited cache', () => {
    assert.equal(isWellFormed(null), false);
    assert.equal(isWellFormed({}), false);
    assert.equal(isWellFormed({ selected: [] }), false, 'no year buckets');
    assert.equal(isWellFormed({ selected: 'nope', 2024: [{}] }), false);
    assert.equal(isWellFormed(HEALTHY), true);
});

test('a first run with no previous data and no baseline is accepted', () => {
    assert.equal(evaluateCandidate(HEALTHY, null, null).ok, true);
});

// Codex, Low: a per-request timestamp changed the body on every origin hit.
test('REGRESSION: identical data renders byte-identical output across calls', () => {
    const meta = { generatedAt: '2026-08-09T00:00:00.000Z' };
    assert.equal(renderSuccess(HEALTHY, meta), renderSuccess(HEALTHY, meta));
});

test('render escapes script-injection vectors', () => {
    const nasty = { selected: [{ title: '</script><img src=x onerror=alert(1)>' }], 2024: [{ t: 1 }] };
    const out = renderSuccess(nasty, { generatedAt: 'x' });
    assert.equal(out.includes('</script'), false);
    assert.equal(out.includes(' '), false);

    const err = renderError('boom </script> ` ${x} "q" \\');
    assert.equal(err.includes('</script'), false);
});

test('rendered payload round-trips to the original data', () => {
    const out = renderSuccess(HEALTHY, { generatedAt: 'x' });
    const win = {};
    new Function('window', out)(win);
    assert.deepEqual(win.publicationsData, HEALTHY);
});
