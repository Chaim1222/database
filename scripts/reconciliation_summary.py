"""
עיצוב סיכום ההשוואה המלאה של הסנכרון השבועי (reconciliation_diff_summary,
migrations/migration_add_reconciliation_diff_all.sql) כטבלת markdown לסיכום הריצה.

מודול עצמאי בכוונה (בלי config/supabase), כדי שאפשר יהיה לבדוק בלי משתני סביבה.
"""

CLASS_ORDER = (
    "only_new", "only_old", "title",
    "status", "source_type", "needs_attention", "is_dictionary_entry",
    "wikipedia_id", "match_type", "maybe_deleted", "template_referenced_title",
    "is_missing", "missing_override_reason", "mechalol_redirect_exists",
)
SIDE_LABEL = {"mechalol": "מכלול", "wikipedia": "ויקיפדיה"}


def _order(row):
    try:
        position = CLASS_ORDER.index(row["change_class"])
    except ValueError:
        position = len(CLASS_ORDER)
    return (row["side"], position, row["change_class"])


def format_summary(rows, audit_id):
    """
    rows: שורות reconciliation_diff_summary (side, change_class, n, n_known_to_delta).
    "לא ידוע לדלתא" = n - n_known_to_delta: מה שהדלתא לא ראתה (עדיין ייתכן תזמון).
    """
    lines = [
        f"### השוואה מלאה: מה השבועית שינתה (audit {audit_id})",
        "",
    ]
    if not rows:
        lines.append("אין הבדלים בין הטבלה הפעילה הקודמת לחדשה.")
        return "\n".join(lines)

    lines += [
        "| צד | סוג שינוי | סה\"כ | ידוע לדלתא | לא ידוע לדלתא |",
        "|---|---|---:|---:|---:|",
    ]
    for row in sorted(rows, key=_order):
        known = row["n_known_to_delta"]
        lines.append(
            f"| {SIDE_LABEL.get(row['side'], row['side'])} | `{row['change_class']}` | "
            f"{row['n']:,} | {known:,} | {row['n'] - known:,} |"
        )
    total = sum(r["n"] for r in rows)
    unknown = sum(r["n"] - r["n_known_to_delta"] for r in rows)
    lines += ["", f"**סך הכול {total:,} שינויים, מתוכם {unknown:,} שהדלתא לא ידעה עליהם.** "
                  "(שורה יכולה להופיע ביותר מסוג אחד; הדוגמאות ב-`reconciliation_diff_examples`.)"]
    return "\n".join(lines)
