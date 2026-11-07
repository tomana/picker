/* A loop's sound through Web Audio. A video's own `loop` leaves some 30 ms of silence at every seam; a decoded buffer
   loops to the sample, at the container's length (decoding honours the edit list, so no AAC padding). The video stays
   muted and follows the sound's clock, late by what the output adds. One voice at a time. */

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
  const mine = cur = { v, src: null, raf: 0 };
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
  const dur = buf.duration, late = () => (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopEnd = dur;
  src.connect(ctx.destination);
  const at = (v.currentTime || 0) % dur;
  src.start(0, at);
  const t0 = ctx.currentTime - at;
  mine.src = src;
  const follow = () => {
    if (cur !== mine) return;
    const want = (((ctx.currentTime - t0 - late()) % dur) + dur) % dur;
    let off = v.currentTime - want;
    if (off > dur / 2) off -= dur;
    else if (off < -dur / 2) off += dur;
    if (Math.abs(off) > 0.08 && v.readyState >= 2 && !v.seeking) v.currentTime = want;
    mine.raf = requestAnimationFrame(follow);
  };
  mine.raf = requestAnimationFrame(follow);
  return true;
}

/* Silences the voice (only video `v`'s, when given). */
export function stopVoice(v = null) {
  if (!cur || (v && cur.v !== v)) return;
  if (cur.src) try { cur.src.stop(); } catch (_) {}
  cancelAnimationFrame(cur.raf);
  cur = null;
}
