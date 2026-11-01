/* Resolve targets each frame across repaints; omit unavailable steps and never mutate the underlying page. */

import { el, glyph } from "../dom.js";

const KIND = {
  picked: "you judge every card, and your votes steer the next",
  hybrid: "a score sorts the cards, and you choose where it can't",
  scored: "a number keeps or drops each try; you read the trail, best first",
};

/* Steps may target the whole page or several parts; text resolves against the current tab. */
export const STEPS = [
  { key: "the picker", line: "What the picker is for.", pic: "picker", say: () => [
      "The picker is a tool for managing agents in an autoresearch loop: they make graphics, assets or code, and each ",
      "result comes back as a card for you to judge. An agent here is an AI assistant (Claude, Codex or Gemini) working ",
      "on this computer. It makes something, you say what you think of it, and it uses that for its next try. The next ",
      "steps go through the page, one part at a time."] },
  { key: "tabs", line: "One tab per thing being made.", at: ".cardhead", say: ({ tab }) => [
      "The tabs: one for each thing being made, and each works in one of three ways. In a picked tab you judge every ",
      "card yourself. In a hybrid tab a score sorts the cards and asks you only where it can't tell. In a scored tab a ",
      "number decides on its own, and you look through the results, best first.",
      ...(tab && KIND[tab.kind] ? [tab.label === tab.kind ? ` This tab is ${tab.kind}.` : ` This one, ${tab.label}, is ${tab.kind}.`] : [])] },
  /* Use one shared step where AUTO owns the playlist. */
  { key: "auto", line: "AUTO makes, and plays what it made.", at: "article.playlist", say: () => [
      "This is AUTO's list. AUTO keeps an agent working without you: it picks cards and asks for new versions, one after ",
      "another, until the agent's subscription runs out for now. What it makes plays here as it arrives, so you can ",
      "listen and vote as you go; ⏭ skips to the next."] },
  { key: "a card", line: "A card and its versions.", at: ".grid article.card:not(.compose)", say: () => [
      "This is a card: one idea, with every version an agent has made of it. ‹ and › step through the versions. − and ",
      "+ are your votes, and they tell the agent what worked; no vote means you haven't judged it yet. Tap the picture ",
      "to open the card; an open card has its own walkthrough, in settings."] },
  { key: "add", line: "Ask for something new.", at: ".grid article.addrec", say: () => [
      "Here you ask for something new: describe it in your own words, or add a recording where the tab takes one, and ",
      "an agent makes a new card from it."] },
  { key: "usage and queue", line: "What the agents have left, and what they make.", at: "section.lbox", say: () => [
      "At the top: how much each agent can still do before its subscription's limit resets, and the queue: the jobs ",
      "being made now, by which agent, and how far each has got. Tap a job to see it; ✕ cancels it."] },
  { key: "auto", line: "AUTO picks and revises on its own.", at: "article.autop", say: () => [
      "AUTO works without you: it picks cards and asks an agent for new versions, one at a time, until the agent's ",
      "subscription runs out for now. Open it to choose which cards it works on and what it should aim for."] },
  { key: "cup", line: "Rank cards two at a time.", at: "article.cup", say: () => [
      "The cup ranks many cards quickly: it shows two at a time and you pick the better one, like a tournament."] },
  { key: "settings", line: "The agents, and this walk.", at: 'button[title^="agents:"]', say: () => [
      "Settings, behind this button: which AI model each agent uses and how hard it thinks, a check that every tab's ",
      "agent answers, what an agent is given for a job, and this walkthrough again."] },
];

/* The card walkthrough opens and closes with its card; several targets may share one spotlight. */

const OPEN = ".sheet.big:not([hidden]) ";
export const CARD_STEPS = [
  { key: "the card", at: OPEN + ".cmedia", say: () => document.querySelector(OPEN + ".vblock") ? [
      "The card's sound, with one lane per voice (one instrument or layer). ▶ plays them all; a lane's own ▶ plays ",
      "only that lane. A lane's − and + vote on that voice, the bin takes it out, the speaker mutes it. ⛶ shows only ",
      "the lanes."] : [
      "The card's picture: what the agent made for this version. A moving one plays."] },
  { key: "send it on", at: [OPEN + "textarea.ideabox", OPEN + ".acts"], say: () => [
      "Write what should change and press revise: the agent makes the next version. Leave it empty, and the agent takes ",
      "the card further or fixes what's weak. Inspire makes a new card that starts from this one. The number beside ",
      "them is how many to make. The ⓘ shows exactly what the agent will be given."] },
  { key: "the text", at: OPEN + ".cdesc", say: () => [
      "The card's name (tap it to copy it, to mention the card in a chat), which agent and model made it, what the card ",
      "is, and below the line what this version changed. log › shows every step of how it was made."] },
  { key: "items", at: OPEN + ".ithumbs", say: () => [
      "What this card holds: tap one to see and hear it alone. ★ marks the one the card shows."] },
  { key: "views", at: OPEN + ".vthumbs", say: () => [
      "This version's other pictures: tap one to see it."] },
  { key: "versions", at: OPEN + ".vbox", say: () => [
      "Every version of the card: tap one to see it. A vote, and anything you send, goes to the version on screen; ▲ ",
      "marks one you voted up."] },
  { key: "the foot", at: OPEN + ".cfoot", say: () => [
      "Along the bottom: put the card in the auto pool (the cards AUTO works on), archive it (nothing is deleted), ",
      "duplicate it, move this version into a card of its own, or download it. Then your vote on this version, − and +."] },
];

let cur = null;
export const walking = () => !!cur;

/* Skip steps whose required targets are absent. */
export const present = (steps = STEPS) => steps.filter((s) => !s.at || find(s.at));

/* Ignore zero-size targets when resolving a visible walkthrough anchor. */
function find1(sel) {
  for (const n of document.querySelectorAll(sel)) { const r = n.getBoundingClientRect(); if (r.width && r.height) return n; }
  return null;
}
/* Treat multi-part steps as unavailable when any required target is missing. */
function find(at) {
  const ns = [].concat(at).map(find1);
  return ns.every(Boolean) ? ns : null;
}
function rectOf(ns) {
  const rs = ns.map((n) => n.getBoundingClientRect());
  const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
  return { left, top, width: Math.max(...rs.map((r) => r.right)) - left, height: Math.max(...rs.map((r) => r.bottom)) - top,
           bottom: Math.max(...rs.map((r) => r.bottom)) };
}

export function walk(ctx, at = 0, { end, steps: all = STEPS }) {
  stop();
  const steps = present(all);
  const hole = el("div.whole"), dim = el("div.wdim");
  const say = el("div.wt"), of = el("span");
  const back = el("button.wbtn", { type: "button" }, [glyph("prev", 14), "back"]);
  const next = el("button.wbtn", { type: "button" });
  const skip = el("button.wskip", { type: "button", text: "skip" });
  const x = el("button.wx", { type: "button", title: "end the walkthrough", "aria-label": "end the walkthrough" },
               [glyph("cut", 18)]);
  const pic = el("div.wpic");                       // a step's picture, when it has one
  const cap = el("div.wcap", { role: "dialog", "aria-live": "polite" },
                 [el("div.wk", {}, [of, x]), pic, say, el("div.wnav", {}, [skip, el("span.wsp"), back, next])]);
  const root = el("div.walk", {}, [dim, hole, cap]);
  document.body.append(root);
  let i = Math.max(0, Math.min(steps.length - 1, at)), last = "";

  const show = () => {
    const s = steps[i];
    cap.setAttribute("aria-label", s.key);           // the step's name for a screen reader; the box shows no title
    of.textContent = `${i + 1} / ${steps.length}`;
    say.replaceChildren(...s.say(ctx));
    pic.replaceChildren(...(s.pic ? [glyph(s.pic, 64)] : []));
    pic.hidden = !s.pic;
    back.disabled = i === 0;
    if (i === steps.length - 1) next.replaceChildren("done"); else next.replaceChildren("next", glyph("next", 14));
    const ns = s.at && find(s.at);
    if (ns) ns[0].scrollIntoView({ block: "center", inline: "nearest" });
    last = "";
    place();
  };
  /* Place the explanation above or below the target, falling back to the viewport foot. */
  const place = () => {
    const s = steps[i], ns = s.at && find(s.at);
    const r = ns ? rectOf(ns) : null;
    const key = r ? `${r.left}|${r.top}|${r.width}|${r.height}|${innerWidth}|${innerHeight}` : `none|${innerWidth}|${innerHeight}`;
    if (key === last) return;
    last = key;
    hole.hidden = !r;
    dim.hidden = !!r;
    const band = document.querySelector(".band");
    const top0 = (band ? Math.max(0, band.getBoundingClientRect().bottom) : 0) + 8;
    const h = cap.offsetHeight, gap = 14;
    let y;
    if (!r) y = Math.max(top0, (innerHeight - h) / 2);
    else {
      Object.assign(hole.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`,
                                  width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      y = r.bottom + gap + h <= innerHeight - 8 ? r.bottom + gap
        : r.top - gap - h >= top0 ? r.top - gap - h
        : innerHeight - 8 - h;
    }
    cap.style.top = `${Math.round(y)}px`;
  };
  const tick = () => { if (cur !== me) return; place(); me.raf = requestAnimationFrame(tick); };
  const key = (e) => {
    if (e.key === "ArrowRight") next.click();
    else if (e.key === "ArrowLeft" && !back.disabled) back.click();
    else return;
    e.preventDefault();
  };

  back.onclick = () => { if (i > 0) { i--; show(); } };
  next.onclick = () => { if (i < steps.length - 1) { i++; show(); } else end(); };
  skip.onclick = x.onclick = () => end();
  const me = { root, key, raf: 0 };
  cur = me;
  document.addEventListener("keydown", key);
  show();
  me.raf = requestAnimationFrame(tick);
}

export function stop() {
  if (!cur) return;
  const { root, key, raf } = cur;
  cur = null;
  cancelAnimationFrame(raf);
  document.removeEventListener("keydown", key);
  root.remove();
}
