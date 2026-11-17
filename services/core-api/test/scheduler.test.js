import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFreeSlots, pickSlot, rankSlots, scoreSlot } from '../src/scheduling/scheduler.js';

const at = (h, m = 0) => new Date(Date.UTC(2030, 0, 7, h, m));
const window = (providerId, startH = 9, endH = 12) => ({ providerId, facilityId: providerId, start: at(startH), end: at(endH), slotMinutes: 30 });

test('generates every slot in an empty window', () => {
  const slots = generateFreeSlots({ windows: [window(1)] });
  assert.equal(slots.length, 6);
  assert.deepEqual(slots[0].start, at(9));
  assert.deepEqual(slots.at(-1).end, at(12));
});

test('skips slots overlapping provider bookings', () => {
  const providerBusy = new Map([[1, [{ start: at(9, 30), end: at(10, 30) }]]]);
  const starts = generateFreeSlots({ windows: [window(1)], providerBusy }).map((s) => s.start.getUTCHours() * 60 + s.start.getUTCMinutes());
  assert.deepEqual(starts, [9 * 60, 10 * 60 + 30, 11 * 60, 11 * 60 + 30]);
});

test('skips slots where the patient is already booked elsewhere', () => {
  const slots = generateFreeSlots({ windows: [window(1)], patientBusy: [{ start: at(9), end: at(11) }] });
  assert.equal(slots.length, 2);
});

test('respects notBefore and longer durations', () => {
  const slots = generateFreeSlots({ windows: [window(1)], durationMinutes: 60, notBefore: at(10) });
  assert.deepEqual(slots.map((s) => s.start.getUTCHours()), [10, 10, 11].slice(0, slots.length));
  for (const s of slots) assert.ok(s.end <= at(12));
});

test('marks utilization and contiguity', () => {
  const providerBusy = new Map([[1, [{ start: at(10), end: at(11) }]]]);
  const slots = generateFreeSlots({ windows: [window(1)], providerBusy });
  assert.ok(Math.abs(slots[0].utilization - 1 / 3) < 1e-9);
  const byStart = Object.fromEntries(slots.map((s) => [s.start.toISOString(), s.contiguous]));
  assert.equal(byStart[at(9).toISOString()], true);       // window edge
  assert.equal(byStart[at(9, 30).toISOString()], true);   // touches booking at 10:00
  assert.equal(byStart[at(11).toISOString()], true);      // right after booking
});

test('urgent requests prefer the earliest slot regardless of preferred time', () => {
  const now = at(8);
  const early = { start: at(9), utilization: 0, contiguous: true };
  const late = { start: at(15), utilization: 0, contiguous: true };
  const opts = { preferredStart: at(15), priority: 1, now };
  assert.ok(scoreSlot(early, opts) < scoreSlot(late, opts));
  assert.ok(scoreSlot(early, { ...opts, priority: 3 }) > scoreSlot(late, { ...opts, priority: 3 }));
});

test('ranking balances load across providers', () => {
  const providerBusy = new Map([[1, [{ start: at(9), end: at(11) }]]]);
  const free = generateFreeSlots({ windows: [window(1), window(2)], providerBusy });
  const ranked = rankSlots(free, { preferredStart: at(11), priority: 3, now: at(8) });
  assert.equal(ranked[0].providerId, 2);
});

test('pickSlot only picks from near-equivalent top candidates', () => {
  const ranked = [{ score: 1 }, { score: 1.2 }, { score: 5 }, { score: 6 }];
  for (let i = 0; i < 50; i++) assert.ok(pickSlot(ranked).score <= 1.5);
  assert.equal(pickSlot([]), null);
  assert.equal(pickSlot(ranked, { rng: () => 0 }), ranked[0]);
});
