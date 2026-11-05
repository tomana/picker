// The new player's state is pure: `node --test tests/unit/*.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOf, initial, reduce, program, outSignal } from "../../static/app/player/state.js";

const lane = (id, extra = {}) => ({ id, kind: "voice", audio: `/media/c1/v2__${id}.mp3`, ...extra });
const CARD = {
  id: "c1",
  versions: [
    { n: 1, duration: 30, media: { audio: "/media/c1/v1__mix.mp3" }, parts: [lane("a"), lane("b")] },
    { n: 2, duration: 300, media: { audio: "/api/cards/c1/mix?version=2&cut=c&k=x", audio_full: "/media/c1/v2__mix.mp3" },
      face_item: "comp1", parts: [lane("a"), lane("b"), lane("c", { archived: true })],
      items: [{ id: "comp1", parts: [] }, { id: "trans", duration: 300, media: { audio: "/media/c1/v2__trans__mix.mp3" },
                                            parts: [lane("a"), lane("x")] }] },
  ],
};
const at = (n, item = null) => initial(sourceOf(CARD, n, item));

test("every lane in plays the mix file; the full one, not the cut one", () => {
  const P = reduce(at(2), { type: "source", src: { ...sourceOf(CARD, 2), lanes: sourceOf(CARD, 2).lanes.map((l) => ({ ...l, out: false })) } });
  assert.deepEqual(program(P), { kind: "mix", key: "mix:/media/c1/v2__mix.mp3", url: "/media/c1/v2__mix.mp3" });
});

test("a lane out (from the card) or muted (here) is a sum of the lanes left", () => {
  let P = at(2);
  assert.equal(program(P).url, "/api/cards/c1/mix?version=2&lanes=a%2Cb");
  P = reduce(P, { type: "mute", lane: "b", on: true });
  assert.equal(program(P).url, "/api/cards/c1/mix?version=2&lanes=a");
  P = reduce(P, { type: "mute", lane: "a", on: true });
  assert.equal(program(P).url, null, "nothing left");
});

test("an item's lanes are its own, and its sum names it", () => {
  const P = reduce(at(2, "trans"), { type: "mute", lane: "x", on: true });
  assert.equal(program(P).url, "/api/cards/c1/mix?version=2&item=trans&lanes=a");
  assert.deepEqual(outSignal(P, "a", true), { kind: "archive", voice: "a", value: true, version: 2, item: "trans" });
  assert.deepEqual(outSignal(at(2), "a", true), { kind: "archive", voice: "a", value: true, version: 2, item: "comp1" });
  assert.deepEqual(outSignal(at(1), "a", false), { kind: "archive", voice: "a", value: false }, "a plain card: unscoped");
});

test("a solo is the lane's own file, whatever else is out", () => {
  const P = reduce(reduce(at(2), { type: "mute", lane: "a", on: true }), { type: "solo", lane: "a" });
  assert.deepEqual(program(P), { kind: "lane", key: "lane:/media/c1/v2__a.mp3", url: "/media/c1/v2__a.mp3" });
  assert.equal(reduce(P, { type: "solo", lane: "zz" }).solo, null);
});

test("a switch keeps the position on a long piece, from 0 on a short one; mutes and the solo stay by id", () => {
  let P = reduce(reduce(at(2), { type: "seek", s: 200 }), { type: "mute", lane: "a", on: true });
  P = reduce(P, { type: "solo", lane: "b" });
  const t = reduce(P, { type: "source", src: sourceOf(CARD, 2, "trans") });
  assert.equal(t.position, 200);
  assert.equal(t.lanes.find((l) => l.id === "a").muted, true);
  assert.equal(t.solo, null, "trans has no b");
  const v1 = reduce(P, { type: "source", src: sourceOf(CARD, 1) });
  assert.equal(v1.position, 0, "a 30-s piece starts from the top");
  assert.equal(v1.solo, "b");
});

test("a fresh card moves a lane out without moving the position", () => {
  const P = reduce(reduce(at(2), { type: "seek", s: 42 }), { type: "pending", lane: "a", on: true });
  const fresh = { ...CARD, versions: [CARD.versions[0], { ...CARD.versions[1], parts: [lane("a", { archived: true }), lane("b"), lane("c")] }] };
  const Q = reduce(P, { type: "source", src: sourceOf(fresh, 2) });
  assert.equal(Q.position, 42);
  assert.deepEqual(Q.lanes.map((l) => [l.id, l.out, l.pending]), [["a", true, false], ["b", false, false], ["c", false, false]]);
  assert.equal(program(Q).url, "/api/cards/c1/mix?version=2&lanes=b%2Cc");
});

test("a mute waits by id through a version without that lane", () => {
  let P = reduce(at(2), { type: "mute", lane: "b", on: true });
  P = reduce(P, { type: "source", src: sourceOf(CARD, 2, "trans") });
  P = reduce(P, { type: "source", src: sourceOf(CARD, 2) });
  assert.equal(P.lanes.find((l) => l.id === "b").muted, true);
  assert.deepEqual(initial(sourceOf(CARD, 1), { muted: ["a"], position: 7 }).lanes.map((l) => l.muted), [true, false]);
  assert.equal(initial(sourceOf(CARD, 1), { muted: ["a"], position: 7 }).position, 7);
});

test("a timed lane's solo says its clip, for the clock", () => {
  const C = { id: "c", versions: [{ n: 1, duration: 60, parts: [lane("a", { time: { start: 10, len: 20 } })] }] };
  const P = reduce(initial(sourceOf(C, 1)), { type: "solo", lane: "a" });
  assert.deepEqual(program(P).clip, { start: 10, len: 20 });
});
