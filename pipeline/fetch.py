"""yfinance에서 시세·재무·컨센서스를 받아 파이프라인 공통 형식으로 바꾼다.

금액은 백만 통화단위(USD $M, KRW 백만원), 퍼센트는 % 숫자.
"""
import datetime as dt
import math
import time

import pandas as pd
import yfinance as yf

M = 1e6
FIN_SECTORS = {"Financial Services", "Real Estate"}


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _m(v):
    x = _num(v)
    return None if x is None else x / M


def _row(df, names):
    """연간 재무표에서 첫 번째로 존재하는 행의 값들(최근 연도 먼저)."""
    if df is None or getattr(df, "empty", True):
        return []
    for n in names:
        if n in df.index:
            return [_num(v) for v in df.loc[n].tolist()]
    return []


def _est(df, period, col):
    try:
        return _num(df.loc[period, col])
    except Exception:  # noqa: BLE001
        return None


def fundamentals(ysym, today=None):
    """종목 하나의 펀더멘털. 실패하면 예외를 그대로 올린다."""
    today = today or dt.date.today().isoformat()
    t = yf.Ticker(ysym)
    info = t.info or {}
    if not info or info.get("quoteType") not in (None, "EQUITY"):
        raise ValueError(f"주식이 아님: {info.get('quoteType')}")
    cur, fin_cur = info.get("currency"), info.get("financialCurrency")
    rec = {
        "name": info.get("longName") or info.get("shortName") or ysym,
        "currency": cur, "financialCurrency": fin_cur,
        "sector": info.get("sector"), "industry": info.get("industry"),
        "shares": _m(info.get("sharesOutstanding") or info.get("impliedSharesOutstanding")),
        "cash": _m(info.get("totalCash")), "debt": _m(info.get("totalDebt")),
        "revenue": _m(info.get("totalRevenue")),
        "netIncome": _m(info.get("netIncomeToCommon")),
        "fcf": _m(info.get("freeCashflow")),
        "beta": _num(info.get("beta")),
        "forwardEps": _num(info.get("forwardEps")),
        "targetLow": _num(info.get("targetLowPrice")), "targetMedian": _num(info.get("targetMedianPrice")),
        "targetHigh": _num(info.get("targetHighPrice")), "targetAnalysts": _num(info.get("numberOfAnalystOpinions")),
        "fundAt": today,
    }
    rg = _num(info.get("revenueGrowth"))
    rec["revGrowthTtm"] = rg * 100 if rg is not None else None  # 최근 분기 전년 대비
    om = _num(info.get("operatingMargins"))
    rec["opIncome"] = rec["revenue"] * om if (rec["revenue"] is not None and om is not None) else None
    dy = _num(info.get("dividendYield"))
    rec["divYield"] = None if dy is None else (dy * 100 if dy < 0.2 else dy)  # 버전에 따라 0.0123 또는 1.23

    # 연간 현금흐름·손익: CapEx, 감가상각, 세율, 5년 영업이익률
    try:
        cf = t.cashflow
        capex = _row(cf, ["Capital Expenditure"])
        da = _row(cf, ["Depreciation And Amortization", "Depreciation Amortization Depletion", "Reconciled Depreciation"])
        rec["capex"] = abs(capex[0]) / M if capex and capex[0] is not None else None
        rec["da"] = da[0] / M if da and da[0] is not None else None
    except Exception:  # noqa: BLE001
        rec["capex"] = rec["da"] = None
    try:
        inc = t.income_stmt
        rev = _row(inc, ["Total Revenue", "Operating Revenue"])
        op = _row(inc, ["Operating Income", "Total Operating Income As Reported"])
        margins = [o / r * 100 for o, r in zip(op, rev) if o is not None and r]
        rec["margin5yAvg"] = sum(margins[:5]) / len(margins[:5]) if margins else None
        rec["marginYears"] = len(margins[:5])
        rv = [r for r in rev if r]
        rec["revCagr3"] = ((rv[0] / rv[3]) ** (1 / 3) - 1) * 100 if len(rv) >= 4 and rv[3] > 0 and rv[0] > 0 else None
        tax = _row(inc, ["Tax Rate For Calcs"])
        rec["taxRate"] = tax[0] * 100 if tax and tax[0] is not None and tax[0] < 1 else None
    except Exception:  # noqa: BLE001
        rec["margin5yAvg"] = rec["taxRate"] = rec["revCagr3"] = None

    # 컨센서스
    try:
        ee = t.earnings_estimate
        rec["epsCurFY"] = _est(ee, "0y", "avg")
        rec["epsNextFY"] = _est(ee, "+1y", "avg")
        rec["epsAnalysts"] = _est(ee, "+1y", "numberOfAnalysts") or _est(ee, "0y", "numberOfAnalysts")
    except Exception:  # noqa: BLE001
        rec["epsCurFY"] = rec["epsNextFY"] = rec["epsAnalysts"] = None
    try:
        re_ = t.revenue_estimate
        rec["revCurFY"] = _m(_est(re_, "0y", "avg"))
        rec["revNextFY"] = _m(_est(re_, "+1y", "avg"))
        g = _est(re_, "+1y", "growth")
        rec["revGrowthNext"] = g * 100 if g is not None else None
    except Exception:  # noqa: BLE001
        rec["revCurFY"] = rec["revNextFY"] = rec["revGrowthNext"] = None
    try:
        cal = t.calendar or {}
        ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
        if ed:
            d0 = ed[0] if isinstance(ed, (list, tuple)) else ed
            rec["nextEarnings"] = pd.Timestamp(d0).date().isoformat()
        else:
            rec["nextEarnings"] = None
    except Exception:  # noqa: BLE001
        rec["nextEarnings"] = None

    rec["excluded"] = "금융업" if rec.get("sector") in FIN_SECTORS else None
    if fin_cur and cur and fin_cur != cur:
        rec["excluded"] = rec["excluded"] or f"재무 통화({fin_cur})와 주가 통화({cur})가 다름"
    return rec


def prices(ysyms, chunk=120, pause=2.0, log=print):
    """최근 1년 일봉으로 종가·기준일·200일 이동평균."""
    out = {}
    for i in range(0, len(ysyms), chunk):
        part = ysyms[i:i + chunk]
        try:
            df = yf.download(part, period="1y", interval="1d", group_by="ticker", auto_adjust=False,
                             threads=True, progress=False)
        except Exception as e:  # noqa: BLE001
            log(f"[prices] 묶음 {i} 실패: {e}")
            continue
        for s in part:
            try:
                sub = df[s] if isinstance(df.columns, pd.MultiIndex) else df
                close = sub["Close"].dropna()
                if close.empty:
                    continue
                out[s] = {
                    "price": round(float(close.iloc[-1]), 4),
                    "priceDate": close.index[-1].date().isoformat(),
                    "sma200": round(float(close.tail(200).mean()), 4) if len(close) >= 150 else None,
                }
            except Exception:  # noqa: BLE001
                continue
        time.sleep(pause)
    return out


def us10y():
    """미국 10년 국채 금리(%) — ^TNX. 값이 20보다 크면 10배 표기로 보고 나눈다."""
    try:
        h = yf.Ticker("^TNX").history(period="5d")["Close"].dropna()
        v = float(h.iloc[-1])
        return round(v / 10 if v > 20 else v, 3), h.index[-1].date().isoformat()
    except Exception:  # noqa: BLE001
        return None, None
