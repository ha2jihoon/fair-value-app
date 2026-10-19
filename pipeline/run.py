"""매일 실행: 유니버스 → 시세(전 종목) → 재무(순환 1/N) → state/*.json 저장.

  python pipeline/run.py                 # 평소 (재무는 5일에 한 바퀴)
  python pipeline/run.py --full          # 재무를 전 종목 받기 (처음 한 번)
  python pipeline/run.py --fixture fixtures   # 네트워크 없이 시험용 데이터로
그다음 `node pipeline/build.js`가 app/data/를 만든다.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
STATE = ROOT / "state"
sys.path.insert(0, str(ROOT / "pipeline"))


def load(p, default):
    try:
        return json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def save(p, obj):
    pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(p).write_text(json.dumps(obj, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--slices", type=int, default=5)
    ap.add_argument("--max-errors", type=int, default=25)
    ap.add_argument("--fixture", default=None)
    ap.add_argument("--today", default=dt.date.today().isoformat())
    a = ap.parse_args()
    today = a.today
    log_lines = []

    def log(msg):
        print(msg, flush=True)
        log_lines.append(msg)

    run = load(STATE / "run.json", {"cursor": 0})
    fund = load(STATE / "fund.json", {})
    params = load(ROOT / "config" / "params.json", {})

    if a.fixture:
        fx = pathlib.Path(a.fixture)
        universe = load(fx / "universe.json", [])
        usrc = {"fixture": len(universe)}
        px = load(fx / "prices.json", {})
        for f in (fx / "fund").glob("*.json"):
            fund[f.stem] = {**fund.get(f.stem, {}), **load(f, {})}
        fund_updated = sorted(p.stem for p in (fx / "fund").glob("*.json"))
        errors = []
        params["rf_us_auto"] = params.get("rf_us")
    else:
        import fetch
        import universe as uni
        universe, usrc = uni.build(log)
        log(f"[universe] {len(universe)}종목 {usrc}")
        # 시세: 전 종목
        sym2id = {u["ysym"]: u["id"] for u in universe}
        raw = fetch.prices(list(sym2id), log=log)
        px = {sym2id[s]: v for s, v in raw.items()}
        log(f"[prices] {len(px)}/{len(universe)}종목")
        rf, rf_at = fetch.us10y()
        if rf:
            params["rf_us"], params["rf_us_asOf"] = rf, rf_at
        # 재무: 순환
        ids = [u["id"] for u in universe]
        missing = [i for i in ids if i not in fund]
        if a.full or not fund:  # 처음 실행이면 전 종목
            batch = ids
        else:
            n = max(1, -(-len(ids) // a.slices))
            start = run.get("cursor", 0) % max(1, len(ids))
            rot = (ids[start:] + ids[:start])[:n]
            batch = list(dict.fromkeys(missing[:n] + rot))  # 처음 보는 종목 먼저
            run["cursor"] = (start + n) % max(1, len(ids))
        byid = {u["id"]: u for u in universe}
        fund_updated, errors, streak = [], [], 0
        for k, i in enumerate(batch):
            u = byid[i]
            try:
                rec = fetch.fundamentals(u["ysym"], today)
                fund[i] = {**rec, "id": i, "ysym": u["ysym"], "market": u["market"],
                           "nameKo": u.get("nameKo"), "gics": u.get("gics")}
                fund_updated.append(i)
                streak = 0
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:160]
                errors.append(f"{i}: {msg}")
                streak += 1
                if "Too Many Requests" in msg or "429" in msg:
                    log("[fund] 요청 제한, 60초 대기")
                    time.sleep(60)
                if streak >= a.max_errors:
                    log(f"[fund] 연속 실패 {streak}회, 이번 실행의 재무 갱신을 멈춤")
                    break
            time.sleep(0.4)
            if k % 25 == 0:
                log(f"[fund] {k + 1}/{len(batch)}")
        log(f"[fund] 갱신 {len(fund_updated)} · 실패 {len(errors)}")
        # 유니버스 이름 정보를 재무 기록에 반영
        for u in universe:
            if u["id"] in fund:
                fund[u["id"]]["nameKo"] = fund[u["id"]].get("nameKo") or u.get("nameKo")

    run.update({"lastRun": today, "universeSources": usrc, "universeSize": len(universe),
                "fundUpdated": fund_updated, "errors": errors[:60], "pricesCount": len(px), "log": log_lines[-40:]})
    save(STATE / "universe.json", universe)
    save(STATE / "prices.json", px)
    save(STATE / "fund.json", fund)
    save(STATE / "params.json", params)
    save(STATE / "run.json", run)


if __name__ == "__main__":
    main()
