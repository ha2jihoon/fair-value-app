"""이슈 제목 "add: AVAV, 123456:KQ" → config/watchlist.txt에 추가.

  python pipeline/add_watch.py "add: AVAV 123456:KQ"
추가된 종목은 표준출력과 $GITHUB_OUTPUT(added=...)에 남긴다.
"""
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from universe import parse_watch_token  # noqa: E402


def main(title):
    m = re.match(r"\s*add\s*:\s*(.+)$", title or "", re.I)
    if not m:
        print("제목이 'add: 티커' 형식이 아님")
        return []
    path = ROOT / "config" / "watchlist.txt"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    have = set()
    for line in text.splitlines():
        for tok in re.split(r"[\s,;]+", line.split("#")[0]):
            w = parse_watch_token(tok)
            if w:
                have.add(w["id"])
    added, raw_added = [], []
    for tok in re.split(r"[\s,;]+", m.group(1))[:10]:
        w = parse_watch_token(tok)
        if not w or w["id"] in have:
            continue
        have.add(w["id"])
        added.append(w["id"])
        raw_added.append(tok.strip().upper())
    if raw_added:
        if text and not text.endswith("\n"):
            text += "\n"
        path.write_text(text + " ".join(raw_added) + "\n", encoding="utf-8")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"added={' '.join(added)}\n")
    print("추가:", " ".join(added) or "없음")
    return added


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]))
