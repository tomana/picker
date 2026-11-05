/* The open card's player state: one plain object, changed only by reduce(). Pure: no DOM, no audio, no fetch, so
   `node --test` reads it directly. What sounds is derived (program), never stored. */

const SHORT = 60;                       // pieces shorter than this start from 0:00 on a version switch (loops)

/* The lanes a version (or one of its items) plays, and the file that is all of them. */
export function sourceOf(card, n, item = null) {
  const v = (card.versions || []).find((x) => x.n === n) || {};
  const face = !item || item === v.face_item;
  const it = face ? null : (v.items || []).find((x) => x.id === item);
  const parts = (face ? v.parts : it && it.parts) || [];
  const m = (face ? v.media : it && it.media) || {};
  return {
    card: card.id, n, item: face ? null : item, face: v.face_item || null, bundled: !!(v.items || []).length,
    duration: (it && it.duration) || v.duration || 0,
    mix: m.audio_full || m.audio || null,
    lanes: parts.filter((p) => p.kind === "voice" && p.audio).map((p) => ({
      id: p.id, label: p.label || p.id, file: p.audio, peaks: p.peaks || null, src: p.src || null,
      time: p.time || null, out: !!p.archived })),
  };
}

export function initial(src) {
  return { ...src, lanes: src.lanes.map((l) => ({ ...l, muted: false, pending: false })),
           solo: null, playing: false, position: 0 };
}

const clamp = (s, d) => Math.max(0, Math.min(d > 0 ? d : Infinity, s));

export function reduce(P, a) {
  switch (a.type) {
    case "play": return P.playing ? P : { ...P, playing: true };
    case "pause": return { ...P, playing: false, position: a.at != null ? clamp(a.at, P.duration) : P.position };
    case "ended": return { ...P, playing: false, position: 0 };
    case "seek": return { ...P, position: clamp(a.s, P.duration) };
    case "mute": return { ...P, lanes: P.lanes.map((l) => (l.id === a.lane ? { ...l, muted: !!a.on } : l)) };
    case "solo": return { ...P, solo: a.lane && P.lanes.some((l) => l.id === a.lane) ? a.lane : null };
    // a take-out or put-back sent, its answer not in yet: the row says so, the sound waits for the card
    case "pending": return { ...P, lanes: P.lanes.map((l) => (l.id === a.lane ? { ...l, pending: !!a.on } : l)) };
    case "source": {
      // a fresh card, or another version or item: what is out comes from the card; mutes and the solo stay by lane id
      const was = new Map(P.lanes.map((l) => [l.id, l]));
      const moved = a.src.n !== P.n || a.src.item !== P.item;
      const at = !moved ? P.position : a.src.duration >= SHORT ? Math.min(P.position, Math.max(0, a.src.duration - 0.5)) : 0;
      return {
        ...P, ...a.src, position: at,
        lanes: a.src.lanes.map((l) => ({ ...l, muted: !!(was.get(l.id) || {}).muted, pending: false })),
        solo: P.solo && a.src.lanes.some((l) => l.id === P.solo) ? P.solo : null,
      };
    }
    default: return P;
  }
}

/* What sounds now, as one URL: a solo lane's own file, the mix file when every lane is in, else the server's sum of
   exactly the lanes in. Two states with the same key sound the same. */
export function program(P) {
  if (P.solo) {
    const l = P.lanes.find((x) => x.id === P.solo);
    if (l) return { kind: "lane", key: `lane:${l.file}`, url: l.file };
  }
  const on = P.lanes.filter((l) => !l.out && !l.muted);
  if (!on.length) return { kind: "none", key: "none", url: null };
  if (on.length === P.lanes.length && P.mix) return { kind: "mix", key: `mix:${P.mix}`, url: P.mix };
  const ids = on.map((l) => l.id).sort();
  const q = new URLSearchParams({ version: String(P.n) });
  if (P.item) q.set("item", P.item);
  q.set("lanes", ids.join(","));
  return { kind: "sum", key: `sum:${P.n}:${P.item || ""}:${ids.join(",")}`,
           url: `/api/cards/${encodeURIComponent(P.card)}/mix?${q}` };
}

/* A take-out or put-back as the signal the server folds: scoped to the version and item on a bundle, as the
   current player sends it. */
export function outSignal(P, lane, on) {
  return { kind: "archive", voice: lane, value: !!on, ...(P.bundled ? { version: P.n, item: P.item || P.face } : {}) };
}
