import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sort_template import parse_sort_template  # noqa: E402


class ParseSortTemplateTests(unittest.TestCase):
    def test_full_template(self):
        text = "תוכן\n{{וח}}\n{{מיון ויקיפדיה|דף=1770 בצרפת|גרסה=38568909|פריט=Q2809364|תאריך=פברואר 2026}}"
        self.assertEqual(
            parse_sort_template(text),
            {"title": "1770 בצרפת", "rev": 38568909, "date": date(2026, 2, 1)},
        )

    def test_spaces_around_values(self):
        text = "{{מיון ויקיפדיה|דף=תלמוד|גרסה=1589756 |תאריך=ספטמבר 2016 }}"
        self.assertEqual(
            parse_sort_template(text),
            {"title": "תלמוד", "rev": 1589756, "date": date(2016, 9, 1)},
        )

    def test_rev_zero_means_no_rev(self):
        text = "{{מיון ויקיפדיה|דף=רבי יוסי|גרסה=0|פריט=Q982075 |תאריך=ספטמבר 2016 }}"
        result = parse_sort_template(text)
        self.assertIsNone(result["rev"])
        self.assertEqual(result["title"], "רבי יוסי")

    def test_missing_rev_param(self):
        result = parse_sort_template("{{מיון ויקיפדיה|דף=F|תאריך=פברואר 2020}}")
        self.assertIsNone(result["rev"])

    def test_non_numeric_or_empty_rev(self):
        self.assertIsNone(parse_sort_template("{{מיון ויקיפדיה|דף=א|גרסה=abc}}")["rev"])
        self.assertIsNone(parse_sort_template("{{מיון ויקיפדיה|דף=א|גרסה=}}")["rev"])

    def test_underscores_and_wikilink_in_title(self):
        self.assertEqual(
            parse_sort_template("{{מיון ויקיפדיה|דף=דה_נאנג|גרסה=21528025}}")["title"],
            "דה נאנג",
        )
        self.assertEqual(
            parse_sort_template("{{מיון ויקיפדיה|דף=[[AGM-45_שרייק]]|גרסה=1}}")["title"],
            "AGM-45 שרייק",
        )

    def test_extra_params_and_order(self):
        text = "{{מיון ויקיפדיה|דף=The Nation|גרסה=26193343|דרגה=נקי|תאריך=פברואר 2020}}"
        self.assertEqual(
            parse_sort_template(text),
            {"title": "The Nation", "rev": 26193343, "date": date(2020, 2, 1)},
        )

    def test_multiline_and_spaced_name(self):
        text = "{{ מיון  ויקיפדיה |\n דף = אבא \n| גרסה = 55 \n| תאריך = מרץ 2019 \n}}"
        self.assertEqual(
            parse_sort_template(text),
            {"title": "אבא", "rev": 55, "date": date(2019, 3, 1)},
        )

    def test_nested_template_inside_value(self):
        text = "{{מיון ויקיפדיה|דף=א|גרסה=7|תאריך={{שם}}}}"
        result = parse_sort_template(text)
        self.assertEqual(result["rev"], 7)
        self.assertIsNone(result["date"])

    def test_pipe_inside_wikilink_does_not_split(self):
        result = parse_sort_template("{{מיון ויקיפדיה|דף=[[א|ב]]|גרסה=9}}")
        self.assertEqual(result["rev"], 9)

    def test_last_template_wins(self):
        text = (
            "{{מיון ויקיפדיה|דף=ראשון|גרסה=1}}\nטקסט\n"
            "{{מיון ויקיפדיה|דף=אחרון|גרסה=2}}"
        )
        self.assertEqual(parse_sort_template(text)["title"], "אחרון")

    def test_no_template(self):
        self.assertIsNone(parse_sort_template("סתם טקסט {{וח}}"))
        self.assertIsNone(parse_sort_template(""))
        self.assertIsNone(parse_sort_template(None))

    def test_unclosed_template(self):
        self.assertIsNone(parse_sort_template("{{מיון ויקיפדיה|דף=א|גרסה=3"))

    def test_bad_date(self):
        self.assertIsNone(parse_sort_template("{{מיון ויקיפדיה|דף=א|גרסה=1|תאריך=בקרוב}}")["date"])
        self.assertIsNone(parse_sort_template("{{מיון ויקיפדיה|דף=א|גרסה=1|תאריך=חודש 2020}}")["date"])


if __name__ == "__main__":
    unittest.main()
