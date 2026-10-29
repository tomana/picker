"""Ranking and eligibility must agree when selecting cup participants."""
import _cfg  # noqa: F401
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from core import cup as C  # noqa: E402


class RankingTest(unittest.TestCase):
    def test_eight_cards(self):
        br = C.bracket(list("abcdefgh"), [
            {"a": "a", "b": "b", "winner": "a"}, {"a": "c", "b": "d", "winner": "d"},
            {"a": "e", "b": "f", "winner": "f"}, {"a": "g", "b": "h", "winner": "g"},
            {"a": "a", "b": "d", "winner": "d"}, {"a": "f", "b": "g", "winner": "f"},
            {"a": "d", "b": "f", "winner": "f"}])
        self.assertEqual(br["winner"], "f")
        rank = C.ranking([list("abcdefgh"), list("ijk")], list("abcdefgh"), br["rounds"])
        self.assertEqual(rank, [(1, "f"), (2, "d"), (3, "a"), (3, "g"),
                                (5, "b"), (5, "c"), (5, "e"), (5, "h"),
                                (9, "i"), (9, "j"), (9, "k")])

    def test_a_bye_leaves_one_third(self):
        # three cards: the top seed's bye, one semi, then the final
        br = C.bracket(["a", "b", "c"], [{"a": "b", "b": "c", "winner": "c"},
                                         {"a": "a", "b": "c", "winner": "a"}])
        self.assertEqual(C.ranking([["a", "b", "c"]], ["a", "b", "c"], br["rounds"]),
                         [(1, "a"), (2, "c"), (3, "b")])

    def test_unfinished_has_no_ranking(self):
        br = C.bracket(list("abcd"), [{"a": "a", "b": "b", "winner": "a"}])
        self.assertEqual(C.ranking([list("abcd")], list("abcd"), br["rounds"]), [])

    def test_two_cards(self):
        br = C.bracket(["a", "b"], [{"a": "a", "b": "b", "winner": "b"}])
        self.assertEqual(C.ranking([["a", "b"]], ["a", "b"], br["rounds"]), [(1, "b"), (2, "a")])


class JudgeableTest(unittest.TestCase):
    def test_recordings_and_the_archived_are_out(self):
        song = {"id": "s", "media": {"audio": "/media/s/mix.mp3"}}
        rec = {"id": "r", "media": {"audio": "/media/r/rec.m4a"}, "origin": {"kind": "recording"}}
        gone = {"id": "g", "media": {"audio": "/media/g/mix.mp3"}, "archived": True}
        self.assertEqual(C.judgeable_of([song, rec, gone]), ["s"])


if __name__ == "__main__":
    unittest.main()
