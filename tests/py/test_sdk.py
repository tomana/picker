"""Example runners and syncs must use the SDK, never core imports or path injection."""
import _cfg  # noqa: F401
import re
import sys
import unittest
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PICKER))
from picker import sdk  # noqa: E402

# Example seeds locate the tree themselves; runners must use the installed SDK.
CALLERS = sorted(p for p in (PICKER / "examples").glob("*/*.py") if p.name != "seed.py")


class SdkTest(unittest.TestCase):
    def test_every_promised_name_resolves(self):
        for name in sdk._EXPORTS:
            with self.subTest(name=name):
                self.assertTrue(callable(getattr(sdk, name)))
        self.assertTrue(callable(sdk.runner.write) and callable(sdk.runner.update) and callable(sdk.runner.finish))
        with self.assertRaises(AttributeError):
            sdk.not_a_name

    def test_a_stand_in_for_core_stands_in_for_the_sdk(self):
        from core import researcher as RS
        real = RS.drain
        RS.drain = lambda *a, **k: "stand-in"
        try:
            self.assertEqual(sdk.drain(), "stand-in")
        finally:
            RS.drain = real

    def test_the_types_take_the_picker_only_through_it(self):
        self.assertTrue(CALLERS)
        for p in CALLERS:
            text = p.read_text()
            with self.subTest(caller=p.relative_to(PICKER)):
                self.assertFalse(re.search(r"^\s*(from core\b|import core\b)", text, re.M), "imports core")
                self.assertFalse(re.search(r"sys\.path\.(insert|append)\(.*picker", text), "puts the picker on its path")


if __name__ == "__main__":
    unittest.main()
