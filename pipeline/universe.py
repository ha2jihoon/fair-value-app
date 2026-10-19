"""감시 종목(유니버스) 만들기.

- 미국: S&P 500 구성 종목 (위키백과 표), 금융·부동산 섹터 제외
- 한국: 한국거래소 시가총액 상위 코스피 150 + 코스닥 30 (KRX 정보데이터시스템), 실패하면 고정 목록
- 공통: config/watchlist.txt, config/notes/*.json 종목은 항상 포함

반환: [{"id", "ysym", "market", "name", "nameKo", "gics", "source"}]
"""
import io
import json
import pathlib
import re

import pandas as pd
import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
UA = {"User-Agent": "Mozilla/5.0 (fair-value-app; personal research)"}
US_EXCLUDE = {"Financials", "Real Estate"}

# 한국 고정 목록 (KRX 조회 실패 시). 코스피 대형주 위주, 금융업 제외
KR_FALLBACK = {
    "005930": "삼성전자", "000660": "SK하이닉스", "373220": "LG에너지솔루션", "207940": "삼성바이오로직스",
    "005380": "현대차", "000270": "기아", "068270": "셀트리온", "012450": "한화에어로스페이스",
    "035420": "NAVER", "012330": "현대모비스", "028260": "삼성물산", "006400": "삼성SDI",
    "051910": "LG화학", "066570": "LG전자", "034020": "두산에너빌리티", "035720": "카카오",
    "096770": "SK이노베이션", "010130": "고려아연", "011200": "HMM", "047810": "한국항공우주",
    "064350": "현대로템", "079550": "LIG넥스원", "033780": "KT&G", "017670": "SK텔레콤",
    "030200": "KT", "282330": "BGF리테일", "139480": "이마트", "097950": "CJ제일제당",
    "271560": "오리온", "007070": "GS리테일",
}


def us_sp500():
    r = requests.get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", headers=UA, timeout=30)
    r.raise_for_status()
    df = pd.read_html(io.StringIO(r.text))[0]
    out = []
    for _, row in df.iterrows():
        sym = str(row["Symbol"]).strip().replace(".", "-")
        gics = str(row.get("GICS Sector", ""))
        if gics in US_EXCLUDE:
            continue
        out.append({"id": sym, "ysym": sym, "market": "US", "name": str(row.get("Security", sym)),
                    "nameKo": None, "gics": gics, "source": "sp500"})
    return out


def _krx(bld, extra):
    url = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
    headers = {**UA, "Referer": "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd"}
    data = {"bld": bld, "locale": "ko_KR", **extra}
    r = requests.post(url, data=data, headers=headers, timeout=30)
    r.raise_for_status()
    js = r.json()
    return js.get("OutBlock_1") or js.get("output") or []


def kr_top(kospi_n=150, kosdaq_n=30, trd_dd=None):
    """KRX 전종목 시세(시가총액 포함)에서 시장별 상위 종목."""
    import datetime as dt
    out = []
    day = trd_dd or dt.date.today()
    for back in range(7):  # 휴장일이면 하루씩 앞으로
        d = (day - dt.timedelta(days=back)).strftime("%Y%m%d")
        rows = []
        for mkt, n, suffix in (("STK", kospi_n, ".KS"), ("KSQ", kosdaq_n, ".KQ")):
            blk = _krx("dbms/MDC/STAT/standard/MDCSTAT01501", {"mktId": mkt, "trdDd": d, "share": "1", "money": "1"})
            blk = [b for b in blk if b.get("MKTCAP")]
            blk.sort(key=lambda b: -float(str(b["MKTCAP"]).replace(",", "")))
            for b in blk[:n]:
                code = b["ISU_SRT_CD"]
                rows.append({"id": code, "ysym": code + suffix, "market": "KR", "name": b.get("ISU_ABBRV", code),
                             "nameKo": b.get("ISU_ABBRV"), "gics": None, "source": "krx"})
        if rows:
            return rows
    return []


def kr_fallback():
    return [{"id": c, "ysym": c + ".KS", "market": "KR", "name": n, "nameKo": n, "gics": None, "source": "fallback"}
            for c, n in KR_FALLBACK.items()]


def parse_watch_token(tok):
    tok = tok.strip().upper()
    if not tok or tok.startswith("#"):
        return None
    m = re.fullmatch(r"(\d{6})(?::(KQ|KS))?", tok)
    if m:
        suffix = ".KQ" if m.group(2) == "KQ" else ".KS"
        return {"id": m.group(1), "ysym": m.group(1) + suffix, "market": "KR"}
    if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,9}", tok):
        sym = tok.replace(".", "-")
        return {"id": sym, "ysym": sym, "market": "US"}
    return None


def watchlist():
    p = ROOT / "config" / "watchlist.txt"
    out = []
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            for tok in re.split(r"[\s,;]+", line.split("#")[0]):
                w = parse_watch_token(tok)
                if w:
                    out.append({**w, "name": w["id"], "nameKo": None, "gics": None, "source": "watchlist"})
    return out


def notes():
    out = []
    for f in sorted((ROOT / "config" / "notes").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        kr = d.get("market") == "KR"
        suffix = ".KQ" if d.get("exchange") == "kosdaq" or d.get("ticker") == "453450" else ".KS"
        out.append({"id": d["ticker"], "ysym": d["ticker"] + suffix if kr else d["ticker"], "market": d.get("market", "US"),
                    "name": d.get("name", d["ticker"]), "nameKo": d.get("name") if kr else None, "gics": None, "source": "note"})
    return out


def build(log=print):
    seen, out = {}, []
    sources = {}

    def add(items, label):
        n = 0
        for it in items:
            if it["id"] in seen:
                prev = seen[it["id"]]
                if not prev.get("nameKo") and it.get("nameKo"):
                    prev["nameKo"] = it["nameKo"]
                continue
            seen[it["id"]] = it
            out.append(it)
            n += 1
        sources[label] = n

    add(notes(), "notes")
    add(watchlist(), "watchlist")
    try:
        add(us_sp500(), "sp500")
    except Exception as e:  # noqa: BLE001
        log(f"[universe] S&P 500 목록 실패: {e}")
        sources["sp500_error"] = str(e)[:200]
    try:
        kr = kr_top()
        if not kr:
            raise RuntimeError("KRX 응답 비어 있음")
        add(kr, "krx")
    except Exception as e:  # noqa: BLE001
        log(f"[universe] KRX 목록 실패, 고정 목록 사용: {e}")
        sources["krx_error"] = str(e)[:200]
        add(kr_fallback(), "kr_fallback")
    # 고정 목록의 한글 이름 보강
    for it in out:
        if it["market"] == "KR" and not it.get("nameKo") and it["id"] in KR_FALLBACK:
            it["nameKo"] = KR_FALLBACK[it["id"]]
    return out, sources


if __name__ == "__main__":
    u, s = build()
    print(len(u), s)
