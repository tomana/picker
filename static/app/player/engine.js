/* The open card's sound: two <audio> elements, one live and one next, and one clock. A program change readies `next`
   a little ahead of where the live one is, waits for the live one to get there, and crossfades; the piece never
   stops. Nothing is decoded in the page: a sum of lanes the server hasn't made yet is streamed from the position
   (`from=`) while it makes the file, and the engine moves onto the file once it exists. */

const FADE = 40;                         // ms, a crossfade or a seek's dip
const POLL = 1000;                       // ms between asks whether a streamed sum's file is made

export function createEngine({ onTick = () => {}, onEnded = () => {}, onError = () => {} } = {}) {
  const make = () => {
    const el = new Audio();
    el.preload = "auto";
    return { el, key: null, url: null, offset: 0, seekable: true, prog: null };
  };
  let live = make(), next = make();
  let playing = false, pos = 0, raf = 0, gen = 0, lead = 0.35, seeking = false, wantSeek = null, poll = 0;
  let jumpTo = null;                     // a seek on a stream: where it is going, until the new stream sounds

  const now = () => (jumpTo != null ? jumpTo : live.key ? live.offset + (live.el.currentTime || 0) : pos);

  const ramp = (el, to, ms = FADE) => new Promise((done) => {
    const from = el.volume, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      try { el.volume = Math.max(0, Math.min(1, from + (to - from) * k)); } catch (_) {}
      if (k < 1) setTimeout(step, 8); else done();
    };
    step();
  });

  const once = (el, names, ms = 8000) => new Promise((ok, no) => {
    const off = () => { for (const n of names) el.removeEventListener(n, hit); el.removeEventListener("error", bad); clearTimeout(t); };
    const hit = () => { off(); ok(); };
    const bad = () => { off(); no(new Error("the sound didn't load")); };
    for (const n of names) el.addEventListener(n, hit);
    el.addEventListener("error", bad);
    const t = setTimeout(() => { off(); no(new Error("the sound took too long")); }, ms);
  });

  const tick = () => {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (!playing) return;
      onTick(now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };

  const wire = (slot) => {
    slot.el.onended = () => { if (slot === live && playing) { playing = false; pos = 0; cancelAnimationFrame(raf); onEnded(); } };
    slot.el.onerror = () => { if (slot === live && slot.key) onError("the sound didn't load"); };
  };
  wire(live); wire(next);

  /* The URL that plays `prog` from `at`: a made file (seekable), or a sum streamed from `at`. */
  async function resolve(prog, at) {
    if (prog.kind !== "sum") return { url: prog.url, offset: 0, seekable: true, made: true };
    const r = await fetch(prog.url, { method: "HEAD" });
    const key = r.headers.get("X-Mix-Key");
    if (r.status === 200) return { url: `${prog.url}&k=${key}`, offset: 0, seekable: true, made: true };
    if (r.status === 202) return { url: `${prog.url}&from=${at.toFixed(3)}`, offset: at, seekable: false, made: false };
    throw new Error(r.status === 404 ? "nothing left to play" : `the mix failed (${r.status})`);
  }

  /* Ready `next` on `prog` at `at` and make it live: a program change readies it a little ahead and waits for the
     live one to get there; a jump (a seek on a stream) swaps as soon as it can play. */
  async function swap(prog, at, my, { jump = false } = {}) {
    const t0 = performance.now();
    const target = playing && !jump ? at + lead : at;
    const got = await resolve(prog, target);
    if (my !== gen) return;
    const n = next;
    n.el.pause();
    n.el.volume = playing ? 0 : 1;
    n.el.src = got.url;
    Object.assign(n, { key: prog.key, url: got.url, offset: got.offset, seekable: got.seekable, prog });
    if (got.seekable) {
      await once(n.el, ["loadedmetadata"]);
      if (my !== gen) return;
      const sought = once(n.el, ["seeked"]);
      n.el.currentTime = target;
      await sought;
    }
    if (n.el.readyState < 3) await once(n.el, ["canplay"]);
    if (my !== gen) return;
    if (playing) {
      if (!jump) lead = Math.max(0.15, Math.min(1.5, (performance.now() - t0) / 1000 * 1.2));
      const wait = jump ? 0 : target - now();
      if (wait > 0.02) await new Promise((r) => setTimeout(r, wait * 1000));
      if (my !== gen) return;
      if (wait < -0.08 && got.seekable) n.el.currentTime = now() + 0.03;   // late: catch up rather than repeat
      try { await n.el.play(); } catch (e) { onError(e.message); return; }
      const old = live;
      live = n; next = old;
      await Promise.all([ramp(n.el, 1), ramp(old.el, 0)]);
      old.el.pause();
    } else {
      const old = live;
      live = n; next = old;
      old.el.pause();
    }
    next.key = null;
    if (my === gen) jumpTo = null;
    if (!got.made) watch(prog, my);
  }

  /* A streamed sum moves onto its made file once the server has it. */
  function watch(prog, my) {
    clearTimeout(poll);
    poll = setTimeout(async () => {
      if (my !== gen || live.key !== prog.key || live.seekable) return;
      let r = null;
      try { r = await fetch(prog.url, { method: "HEAD" }); } catch (_) {}
      if (my !== gen) return;
      if (r && r.status === 200) swap(prog, now(), ++gen).catch((e) => onError(e.message));
      else watch(prog, my);
    }, POLL);
  }

  return {
    get playing() { return playing; },
    get position() { return now(); },
    get key() { return live.key; },
    get streaming() { return !!live.key && !live.seekable; },
    elements: () => [live.el, next.el],

    /* What sounds becomes `prog`, at `at` s. The same program again changes nothing unless `force`. */
    async load(prog, at, { force = false, jump = false } = {}) {
      if (!prog || !prog.url) {
        gen++;
        jumpTo = null;
        if (live.key) pos = now();
        live.el.pause(); live.key = null;
        pos = at;
        return;
      }
      if (prog.key === live.key && !force) return;
      if (!live.key) pos = at;
      const my = ++gen;
      jumpTo = jump && live.key ? at : null;
      try { await swap(prog, at, my, { jump }); } catch (e) { if (my === gen) { jumpTo = null; onError(e.message); } }
    },

    async play() {
      if (!live.key) return false;
      playing = true;
      live.el.volume = 1;
      try { await live.el.play(); } catch (e) { playing = false; onError(e.message); return false; }
      tick();
      return true;
    },

    pause() {
      if (live.key) pos = now();
      playing = false;
      cancelAnimationFrame(raf);
      live.el.pause();
      next.el.pause();
      return pos;
    },

    /* A seek in place: the live file jumps under a short dip, one seek in flight, the last one asked wins. A stream
       can't seek: `final` seeks reload it from there; a drag's moves only move the head. */
    seek(s, { final = true } = {}) {
      if (!live.key) { pos = s; return; }
      if (!live.seekable) {
        if (final) this.load(live.prog, s, { force: true, jump: true });
        return;
      }
      if (seeking) { wantSeek = s; return; }
      seeking = true;
      const el = live.el, was = playing;
      if (was) el.volume = 0;
      el.addEventListener("seeked", () => {
        seeking = false;
        if (wantSeek != null) { const w = wantSeek; wantSeek = null; this.seek(w, { final }); return; }
        if (was && playing) ramp(el, 1, FADE / 2);
      }, { once: true });
      el.currentTime = Math.max(0, s - live.offset);
    },

    stop() {
      gen++;
      clearTimeout(poll);
      this.pause();
      for (const s of [live, next]) { s.key = null; s.el.removeAttribute("src"); s.el.load(); }
    },
  };
}
