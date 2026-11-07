/* A loop's sound through Web Audio. A video's own `loop` leaves some 30 ms of silence at every seam; a decoded buffer
   loops to the sample, at the container's length (decoding honours the edit list, so no AAC padding). The video stays
   muted and follows the sound: each frame shown is set against the sound heard as it shows (the output's own clock),
   its pace nudged when they differ (a seek decodes from a keyframe and stutters), a jump when far apart. A jump back to
   the start holds its first frame some 80 ms, so a twin waits there paused and starts that much before the sound goes
   round (a paused player starts in a steady ~50 ms, measured each time round), and takes over. One voice at a time. */

let ctx = null, cur = null;
const decoded = new Map();               // url → Promise<AudioBuffer>, a few kept

function buffer(url) {
  if (!decoded.has(url)) {
    if (decoded.size >= 6) decoded.delete(decoded.keys().next().value);
    decoded.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)));
  }
  return decoded.get(url);
}

/* Gives video `v` its sound from `url`. Resolves false when it can't (no decode): the caller unmutes the video instead. */
export async function loopVoice(v, url) {
  stopVoice();
  const mine = cur = { v, twin: null, show: v, src: null, raf: 0, vfcs: new Map(), ended: null };
  let buf;
  try {
    ctx = ctx || new AudioContext();
    await ctx.resume();
    buf = await buffer(url);
  } catch (_) {
    decoded.delete(url);
    if (cur === mine) cur = null;
    return false;
  }
  if (cur !== mine) return true;         // stopped meanwhile
  const dur = buf.duration;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopEnd = dur;
  src.connect(ctx.destination);
  const at = (v.currentTime || 0) % dur;
  src.start(0, at);
  const t0 = ctx.currentTime - at;
  mine.src = src;
  // the sound's place in its loop when the output plays it at `ms` (performance.now() time)
  const heard = (ms) => {
    const o = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : {};
    const c = o.performanceTime ? o.contextTime + (ms - o.performanceTime) / 1000
                                : ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
    return (((c - t0) % dur) + dur) % dur;
  };
  // a frame shown is the last one begun: up to a frame behind the sound, half on average. Within that its pace stays 1
  // (off 1, frames are skipped or doubled)
  let fd = 1 / 30, prev = null;          // a frame's length (s), the smallest step seen; the last frame's time
  const keep = (el, shown, h) => {
    if (prev != null && shown - prev > 0.008 && shown - prev < fd) fd = shown - prev;
    prev = shown;
    let off = shown - h;
    if (off > dur / 2) off -= dur;
    else if (off < -dur / 2) off += dur;
    if (el.readyState < 2 || el.seeking) return;
    const err = off + fd / 2;
    if (Math.abs(off) > 0.1) { el.currentTime = heard(performance.now()); el.playbackRate = 1; return; }
    // in steps, set only when the step changes: a rate set every frame never takes hold
    const r = Math.abs(err) <= fd / 2 ? 1 : Math.round((1 - Math.max(-0.25, Math.min(0.25, err * 6))) * 20) / 20;
    if (el.playbackRate !== r) el.playbackRate = r;
  };

  if (!v.requestVideoFrameCallback) {     // no frame times: its own loop, kept to the sound as near as a clock read can
    const tick = () => {
      if (cur !== mine) return;
      keep(v, v.currentTime, heard(performance.now()));
      mine.raf = requestAnimationFrame(tick);
    };
    mine.raf = requestAnimationFrame(tick);
    return true;
  }

  const twin = v.cloneNode(false);
  for (const a of ["data-loop", "data-playing", "src"]) twin.removeAttribute(a);
  twin.className = "anim";
  Object.assign(twin, { muted: true, loop: false, preload: "auto", playsInline: true });
  twin.src = v.currentSrc || v.src;
  v.after(twin);
  v.loop = false;
  mine.twin = twin;
  let lead = 0.055, next = null;         // how early the waiting one starts (s); it, and when the sound goes round (ms)
  const frame = (el) => (_, m) => {
    if (cur !== mine) return;
    if (el === mine.show && !next) {
      const h = heard(m.expectedDisplayTime), wait = el === v ? twin : v;
      if (m.mediaTime > dur - 0.5 && dur - h < lead + 0.008 && wait.readyState >= 2 && !wait.seeking) {
        next = { el: wait, round: performance.now() + (dur - heard(performance.now())) * 1000 };
        wait.play().catch(() => {});
      } else keep(el, m.mediaTime, h);
    } else if (next && el === next.el) {  // its first frame: it takes over, and says how early it should have started
      const origin = m.expectedDisplayTime - m.mediaTime * 1000;
      lead = Math.max(0.01, Math.min(0.2, lead + 0.5 * (origin - next.round) / 1000));
      const old = mine.show;
      el.classList.add("on");
      old.classList.remove("on");
      old.pause();
      old.playbackRate = 1;
      old.currentTime = 0;
      mine.show = el;
      next = null;
      prev = null;
    }
    mine.vfcs.set(el, el.requestVideoFrameCallback(frame(el)));
  };
  // the one showing ran out before its twin could take over: back to the sound's place
  mine.ended = (e) => {
    if (cur !== mine || e.target !== mine.show || next) return;
    e.target.currentTime = heard(performance.now());
    e.target.play().catch(() => {});
  };
  for (const el of [v, twin]) {
    el.addEventListener("ended", mine.ended);
    mine.vfcs.set(el, el.requestVideoFrameCallback(frame(el)));
  }
  return true;
}

/* Silences the voice (only video `v`'s, when given); `v` plays on by itself, muted. */
export function stopVoice(v = null) {
  if (!cur || (v && cur.v !== v)) return;
  const c = cur;
  cur = null;
  if (c.src) try { c.src.stop(); } catch (_) {}
  cancelAnimationFrame(c.raf);
  for (const [el, id] of c.vfcs) if (el.cancelVideoFrameCallback) el.cancelVideoFrameCallback(id);
  if (c.twin) {
    if (c.show === c.twin) {
      c.v.currentTime = c.twin.currentTime;
      c.v.classList.add("on");
      c.v.play().catch(() => {});
    }
    c.twin.pause();
    c.twin.removeAttribute("src");
    c.twin.load();
    c.twin.remove();
    c.v.removeEventListener("ended", c.ended);
  }
  c.v.loop = true;
  c.v.playbackRate = 1;
}
