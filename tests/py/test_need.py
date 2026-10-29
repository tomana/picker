"""Needs combine scores, doubts and votes without reading the store."""

import _cfg  # noqa: F401
import sys
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))
from core import signals as SIG                        # noqa: E402


def card(cid, *scores, votes=(), doubts=(), archived=False, card_vote=0):
    """A card with one version per score (oldest first); `votes` per version, as the API folds them."""
    vs = []
    for i, s in enumerate(scores):
        v = {"id": f"v{i + 1}", "n": i + 1, "score": {"name": "loss", "value": s, "lower_is_better": True}}
        if i < len(votes) and votes[i]:
            v["vote"] = votes[i]
        vs.append(v)
    if doubts:
        vs[-1]["doubts"] = list(doubts)
    return {"id": cid, "type": "t", "archived": archived, "vote": card_vote, "versions": vs}


class Need(unittest.TestCase):
    def test_uncalibrated_worse_first(self):
        n = SIG.need([card("a", 1.0), card("b", 5.0), card("c", 3.0)])
        self.assertGreater(n["b"]["value"], n["c"]["value"])
        self.assertGreater(n["c"]["value"], n["a"]["value"])
        self.assertIn("not heard yet", n["a"]["why"][0])

    def test_heard_is_zero_and_a_new_version_asks_again(self):
        n = SIG.need([card("a", 2.0, votes=(1,)), card("b", 2.0, 1.5, votes=(1,))])
        self.assertEqual(n["a"]["value"], 0.0)               # one version, voted
        self.assertGreater(n["b"]["value"], 0.0)             # its newest version is unheard
        n = SIG.need([card("a", 2.0, card_vote=-1)])         # one version: the card's vote is its version's
        self.assertEqual(n["a"]["value"], 0.0)

    def test_archived_is_zero(self):
        self.assertEqual(SIG.need([card("a", 9.0, archived=True)])["a"]["value"], 0.0)

    def test_votes_bracket(self):
        cards = [card("up", 2.0, votes=(1,)), card("down", 4.0, votes=(-1,)),
                 card("good", 1.5), card("mid", 3.0), card("bad", 6.0)]
        n = SIG.need(cards)
        self.assertLess(n["good"]["value"], 0.3)             # as good as what was voted up: taken on its own
        self.assertEqual(n["mid"]["value"], 0.8)             # between the two: the ear decides
        self.assertEqual(n["bad"]["value"], 0.5)             # as far off as one voted down
        self.assertGreater(n["mid"]["value"], n["bad"]["value"])

    def test_disagreement_is_high(self):
        # a 2.0 voted down and a 3.0 voted up: between them the score can't be trusted
        n = SIG.need([card("up", 3.0, votes=(1,)), card("down", 2.0, votes=(-1,)), card("x", 2.5)])
        self.assertEqual(n["x"]["value"], 0.8)
        self.assertIn("disagree", n["x"]["why"][0])

    def test_doubts_add_and_show(self):
        n = SIG.need([card("a", 1.0, doubts=("two judges disagree",)), card("b", 1.0)])
        self.assertGreaterEqual(n["a"]["value"], SIG.EAR)       # a doubt is enough for the mark…
        self.assertLess(n["b"]["value"], SIG.EAR)               # …and no doubt and no vote never is
        self.assertIn("two judges disagree", n["a"]["why"])
        n = SIG.need([card("w", 9.0, doubts=("x",)), card("v", 1.0)])
        self.assertAlmostEqual(n["w"]["value"], 0.9, places=2)  # over EAR already: + 0.2
        self.assertLessEqual(SIG.need([card("c", 1.0, doubts=("x",) * 9)])["c"]["value"], 1.0)

    def test_higher_is_better(self):
        hi = lambda cid, s: {"id": cid, "versions": [{"score": {"name": "r", "value": s, "lower_is_better": False}}]}
        n = SIG.need([hi("a", 0.9), hi("b", 0.1)])
        self.assertGreater(n["b"]["value"], n["a"]["value"])

    def test_higher_is_better_calibrated(self):
        # a higher-is-better score keeps its sign and its comparison in the reasons
        hi = lambda cid, s, vote=0: {"id": cid, "versions": [{"score": {"name": "r", "value": s, "lower_is_better": False},
                                                              **({"vote": vote} if vote else {})}]}
        n = SIG.need([hi("up", 0.8, 1), hi("worse", 0.5), hi("better", 0.9), hi("neg", -0.2)])
        self.assertIn("0.5 < 0.8", n["worse"]["why"][0])
        self.assertLess(n["better"]["value"], n["worse"]["value"])     # as good as one voted up: taken on its own
        self.assertIn("-0.2", n["neg"]["why"][0])                       # a negative score keeps its sign

    def test_no_score(self):
        self.assertEqual(SIG.need([{"id": "a", "versions": [{"parts": [{"kind": "voice"}]}]}])["a"]["value"], 0.5)

    def test_nothing_made_yet(self):
        # a sample card (its version holds only the sample): after every card with a try, but not heard either
        n = SIG.need([{"id": "s", "versions": [{"parts": [], "media": {"reference": "media/reference.wav"}}]},
                      card("a", 1.0)])
        self.assertEqual(n["s"]["why"], ["nothing made yet"])
        self.assertLess(n["s"]["value"], n["a"]["value"])

    def test_groups_calibrate_apart(self):
        a = card("up", 5.0, votes=(1,))
        b = card("x", 4.0)
        b["versions"][0]["score"]["group"] = "snare"          # another family's scale: kick votes don't set its bar
        n = SIG.need([a, b])
        self.assertIn("not heard yet", n["x"]["why"][0])


if __name__ == "__main__":
    unittest.main()
