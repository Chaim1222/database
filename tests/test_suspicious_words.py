"""
הרצה: python -m unittest discover -s tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from suspicious_words import (  # noqa: E402
    compile_lists, is_clean, load_lists, mask_wikitext, parse_bmh, parse_bomah, scan, split_alternatives,
)

LISTS = load_lists("snapshot")


def found(text, category=None, scope="visible"):
    cats = {category} if category else None
    return [m.text for m in scan(text, LISTS, scope, cats)]


class SplitAlternativesTest(unittest.TestCase):
    def test_splits_only_at_top_level(self):
        self.assertEqual(
            split_alternatives(r"א|[^(ת|מ)]ב|(ג|ד)ה|ו\|ז|"),
            ["א", "[^(ת|מ)]ב", "(ג|ד)ה", r"ו\|ז", ""],
        )


class ParseListsTest(unittest.TestCase):
    def test_bmh_by_heading(self):
        text = "==ירוק==\n<div></div>\n<!--  -->\nא|ב\n<!--  -->\n==כחול==\n<!--  -->\nג|\n<!--  -->\n"
        parsed = {c.key: v for c, v in parse_bmh(text).items()}
        self.assertEqual(parsed, {"bmh_green": ["א", "ב"], "bmh_blue": ["ג", ""]})

    def test_bomah_ignores_lines_without_star_like_gadget(self):
        text = "כותרת\n-----\n*א//\nב//\n*ג //\n<!-- -->\n*ד//\n"
        parsed, ignored = parse_bomah(text)
        self.assertEqual({c.key: v for c, v in parsed.items()},
                         {"bomah_modesty": ["א", "ג"], "bomah_general": ["ד"]})
        self.assertEqual([line for _, line in ignored], ["ב//"])

    def test_snapshot_compiles_and_reports_known_problems(self):
        self.assertGreater(len(LISTS.patterns), 400)
        problems = {(key, src) for key, src, _ in LISTS.problems}
        self.assertIn(("bmh_blue", ""), problems)
        self.assertIn(("bomah_general", "אהב[תוה]//"), problems)

    def test_empty_alternative_dropped(self):
        lists = compile_lists("==כחול==\n<!--  -->\nישו|\n<!--  -->\n")
        self.assertEqual([p.source for p in lists.patterns], ["ישו"])


class FixesTest(unittest.TestCase):
    def test_caret_in_middle_now_matches(self):
        self.assertIn("אנס", found("הוא אנס אותה", "bomah_modesty"))
        self.assertNotIn("אונס", found("אונסק\"ו", "bomah_modesty"))

    def test_garbled_lesbian_pattern_now_matches(self):
        self.assertIn("לסביות", found("זוג לסביות", "bomah_modesty"))

    def test_zonah_lookbehind_words(self):
        self.assertEqual(found("מדינת אריזונה", "bmh_dark_red"), [])
        self.assertEqual(found("תזונה נכונה", "bmh_dark_red"), [])
        self.assertIn("זונה", found("היא זונה", "bmh_dark_red"))

    def test_zayin_standalone_but_not_weapons(self):
        self.assertEqual(found("כלי זין רבים", "bmh_dark_red"), [])
        self.assertIn("זין", found("אמר זין", "bmh_dark_red"))

    def test_dolphin(self):
        self.assertEqual(found("דולפין", "bmh_green"), [])
        self.assertIn("לפין", found("שלפין", "bmh_green"))

    def test_whole_text_anchor_becomes_word(self):
        self.assertIn("שדי", found("אל שדי הוא", "bomah_general"))
        self.assertEqual(found("שדים", "bomah_general"), [])


class MaskTest(unittest.TestCase):
    def test_same_length_and_lines(self):
        text = "א {{ת|x=ב}}\n[[ג|ד]] <!-- ה\nו -->"
        masked = mask_wikitext(text)
        self.assertEqual(len(masked), len(text))
        self.assertEqual(masked.count("\n"), text.count("\n"))

    def test_hides_markup_keeps_visible_text(self):
        text = ('<!-- הערה -->{{תבנית|שם=ערך|חופשי}} [[יעד|כינוי]] [[ערך]] '
                '[[קובץ:ש.jpg|ממוזער|250px|כיתוב]] <ref name="n">מקור</ref> https://a.b/c '
                '[[קטגוריה:שם|מיון]] {{{1|פרמטר}}} <math>x</math> [[en:Foo]]')
        words = mask_wikitext(text).split()
        self.assertEqual(words, ["ערך", "חופשי", "כינוי", "ערך", "כיתוב", "מקור", "שם"])

    def test_pipe_inside_link_inside_template(self):
        words = mask_wikitext("{{ת|א=[[יעד|כינוי]]|ב}}").split()
        self.assertEqual(words, ["כינוי", "ב"])


class ScanTest(unittest.TestCase):
    def test_visible_scope_ignores_hidden_markup(self):
        text = "<!-- סקס -->{{סקס}} [[סקס|ערך]] [[קובץ:sex.jpg|ממוזער]]"
        self.assertEqual(found(text, "bmh_dark_red"), [])
        self.assertTrue(found(text, "bmh_dark_red", scope="raw"))

    def test_link_without_alias_is_visible(self):
        self.assertEqual(found("ראו [[פורנוגרפיה]]", "bomah_modesty"), ["פורנו"])

    def test_purple_runs_on_raw_text(self):
        self.assertIn("ויקיפדיה:", found("{{ת|ויקיפדיה:דף}}", "bmh_purple"))

    def test_same_span_from_many_patterns_is_one_match(self):
        matches = scan("על זנות", LISTS, categories={"bmh_dark_red"})
        self.assertEqual(len(matches), 1)
        self.assertGreater(len(matches[0].patterns), 1)

    def test_position_line_and_context(self):
        text = "שורה\nמשהו פורנו כאן"
        (m,) = scan(text, LISTS, categories={"bmh_dark_red"})
        self.assertEqual((m.line, text[m.start:m.end]), (2, "פורנו"))
        self.assertIn("【פורנו】", m.context)

    def test_allowlist(self):
        self.assertTrue(found("נמצא מין חדש של ציפור", "bmh_dark_red"))
        self.assertFalse(scan("נמצא מין חדש של ציפור", LISTS, categories={"bmh_dark_red"}, allowlist=[r"מין חדש"]))

    def test_is_clean_uses_only_blocking_categories(self):
        self.assertTrue(is_clean("לפני מיליון שנה", LISTS))
        self.assertFalse(is_clean("תעשיית הפורנו", LISTS))


if __name__ == "__main__":
    unittest.main()
