/* 적정주가 계산 엔진 — fairvalue.py와 같은 식. 입력 단위: 금액 = 백만 통화단위, 퍼센트 = % 숫자 */
const FV = (() => {
  const CATEGORY_BAND = { bigtech: 7.5, mid: 15, small: 25, value: 5 };
  const DEFAULT_SCEN = { growth: 3, margin: 2, wacc: 1, mult: 20, tg: 0.5 };
  const DEFAULT_WEIGHTS = { dcf: 50, rel: 50, peg: 0, target: 0 };
  const DEFAULT_POSITION = { cap: 5, tranches: 5 };

  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const or0 = (v) => num(v) ?? 0;

  function waccOf(d) {
    const tax = or0(d.tax);
    if (d.waccMode === "manual" && num(d.waccManual) !== null) {
      return { wacc: num(d.waccManual), re: null, wd: null, rdAfter: null, mode: "manual" };
    }
    const rf = num(d.rf), beta = num(d.beta), erp = num(d.erp);
    if (rf === null || beta === null || erp === null) return null;
    const re = rf + beta * erp;
    const eVal = or0(d.price) * or0(d.shares);
    const debt = or0(d.debt);
    const rd = num(d.rd) ?? rf;
    const wd = eVal + debt > 0 ? debt / (eVal + debt) : 0;
    const rdAfter = rd * (1 - tax / 100);
    return { wacc: (1 - wd) * re + wd * rdAfter, re, wd: wd * 100, rdAfter, mode: "capm" };
  }

  function dcf(d, adj = {}, growthOverride = null, waccBase = null) {
    const rev0 = num(d.revenue0), shares = num(d.shares);
    if (!rev0 || !shares || shares <= 0) return null;
    if (waccBase === null) {
      const wb = waccOf(d);
      if (!wb) return null;
      waccBase = wb.wacc;
    }
    const W = (waccBase + (adj.wacc || 0)) / 100;
    const G = (or0(d.tg) + (adj.tg || 0)) / 100;
    if (W - G < 0.005) return { error: "WACC가 영구성장률보다 0.5%p 이상 커야 합니다." };
    let g1, g5;
    if (growthOverride !== null) { g1 = g5 = growthOverride / 100; }
    else {
      g1 = (or0(d.growth1) + (adj.growth || 0)) / 100;
      g5 = (or0(d.growth5) + (adj.growth || 0)) / 100;
    }
    const m0 = or0(d.margin0) / 100, m5 = (or0(d.margin5) + (adj.margin || 0)) / 100;
    const r0 = or0(d.reinvest0) / 100, r5 = or0(d.reinvest5) / 100, t = or0(d.tax) / 100;
    let rev = rev0, pvSum = 0;
    const rows = [];
    for (let k = 1; k <= 5; k++) {
      const gk = g1 + (g5 - g1) * (k - 1) / 4;
      rev = rev * (1 + gk);
      const mk = m0 + (m5 - m0) * k / 5;
      const rk = r0 + (r5 - r0) * k / 5;
      const ebit = rev * mk;
      const nopat = ebit - Math.max(ebit, 0) * t;
      const reinv = rev * rk;
      const fcff = nopat - reinv;
      const pv = fcff / Math.pow(1 + W, k);
      pvSum += pv;
      rows.push({ year: k, growth: gk * 100, revenue: rev, margin: mk * 100, ebit, nopat, reinvest: reinv, fcff, pv });
    }
    const fcff5 = rows[4].fcff;
    const tv = fcff5 * (1 + G) / (W - G);
    const pvTv = tv / Math.pow(1 + W, 5);
    const ev = pvSum + pvTv;
    const equity = ev + or0(d.cash) - or0(d.debt);
    return { rows, pvSum, tv, pvTv, ev, equity, perShare: equity / shares,
      tvShare: ev > 0 ? pvTv / ev * 100 : null, wacc: W * 100, tg: G * 100 };
  }

  function relative(d, multAdj = 0) {
    const f = 1 + multAdj / 100;
    if ((d.relMethod || "pe") === "ps") {
      const rev = num(d.fwdRevenue), shares = num(d.shares), ps = num(d.peerPs);
      if (!rev || !shares || !ps) return null;
      return rev / shares * ps * f;
    }
    const eps = num(d.fwdEps), pe = num(d.peerPe);
    if (eps === null || pe === null || eps <= 0) return null;
    return eps * pe * f;
  }

  function pegValue(d, multAdj = 0) {
    const eps = num(d.fwdEps), g = num(d.epsGrowth), tp = num(d.pegTarget) || 1;
    if (eps === null || g === null || eps <= 0 || g <= 0) return null;
    return eps * g * tp * (1 + multAdj / 100);
  }

  function tickSize(p, cur) {
    if (cur === "KRW") {
      if (p < 2000) return 1; if (p < 5000) return 5; if (p < 20000) return 10;
      if (p < 50000) return 50; if (p < 200000) return 100; if (p < 500000) return 500;
      return 1000;
    }
    return 0.01;
  }
  function floorTick(p, cur) {
    if (p === null || !(p > 0)) return null;
    const t = tickSize(p, cur);
    const v = Math.floor(p / t + 1e-9) * t;
    return t < 1 ? Math.round(v * 100) / 100 : Math.round(v);
  }

  function reverseDcf(d, waccBase) {
    const price = num(d.price);
    if (!price) return null;
    const f = (x) => {
      const r = dcf(d, {}, x, waccBase);
      if (!r || r.error) return null;
      return r.perShare - price;
    };
    let lo = -50, hi = 150, flo = f(lo), fhi = f(hi);
    if (flo === null || fhi === null || flo * fhi > 0) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (fm === null) return null;
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  function compute(d) {
    const scen = { ...DEFAULT_SCEN, ...(d.scen || {}) };
    const weights = { ...DEFAULT_WEIGHTS, ...(d.weights || {}) };
    const position = { ...DEFAULT_POSITION, ...(d.position || {}) };
    const price = num(d.price), cur = d.currency || "USD";
    const wb = waccOf(d);
    const waccBase = wb ? wb.wacc : null;
    const adj = {
      bear: { growth: -scen.growth, margin: -scen.margin, wacc: scen.wacc, tg: -scen.tg },
      base: {},
      bull: { growth: scen.growth, margin: scen.margin, wacc: -scen.wacc, tg: scen.tg },
    };
    const mult = { bear: -scen.mult, base: 0, bull: scen.mult };
    const S = ["bear", "base", "bull"];
    const methods = {}, dcfRuns = {};
    if (waccBase !== null) for (const s of S) dcfRuns[s] = dcf(d, adj[s], null, waccBase);
    if (waccBase !== null && S.every((s) => dcfRuns[s] && !dcfRuns[s].error)) {
      methods.dcf = Object.fromEntries(S.map((s) => [s, dcfRuns[s].perShare]));
    }
    const rel = Object.fromEntries(S.map((s) => [s, relative(d, mult[s])]));
    if (rel.base !== null) methods.rel = rel;
    const peg = Object.fromEntries(S.map((s) => [s, pegValue(d, mult[s])]));
    if (peg.base !== null) methods.peg = peg;
    const tl = num(d.targetLow), tm = num(d.targetMedian), th = num(d.targetHigh);
    if (tm !== null) methods.target = { bear: tl ?? tm, base: tm, bull: th ?? tm };

    const used = Object.keys(methods).filter((m) => (num(weights[m]) || 0) > 0);
    const wsum = used.reduce((a, m) => a + num(weights[m]), 0);
    const blend = {};
    for (const s of S) blend[s] = wsum > 0 ? used.reduce((a, m) => a + num(weights[m]) * methods[m][s], 0) / wsum : null;

    const band = CATEGORY_BAND[d.category || "mid"] ?? 15;
    const fair = blend.base;
    const out = { wacc: wb, methods, blend, usedMethods: used, band, dcfRuns };
    if (fair !== null && fair > 0) {
      out.range = { low: fair * (1 - band / 100), high: fair * (1 + band / 100) };
      if (price) {
        out.gap = (price / fair - 1) * 100;
        out.status = price < out.range.low ? "below" : price > out.range.high ? "above" : "within";
      }
      const beta = num(d.beta) || 1;
      const step = beta >= 1.5 ? 10 : 5;
      const n = parseInt(position.tranches, 10) || 5;
      const cap = num(position.cap) || 5;
      out.ladder = { step, each: cap / n,
        prices: Array.from({ length: n }, (_, k) => floorTick(fair * (1 - step * k / 100), cur)) };
    }
    const eps = num(d.fwdEps);
    if (price && eps && eps > 0) {
      out.fwdPe = price / eps;
      const g = num(d.epsGrowth);
      if (g && g > 0) out.peg = out.fwdPe / g;
    }
    if (dcfRuns.base && !dcfRuns.base.error) out.dcfBase = dcfRuns.base;
    else if (dcfRuns.base && dcfRuns.base.error) out.dcfError = dcfRuns.base.error;
    if (waccBase !== null) {
      out.reverseGrowth = reverseDcf(d, waccBase);
      const steps = [-1, -0.5, 0, 0.5, 1];
      const tg = or0(d.tg);
      out.sensitivity = {
        waccs: steps.map((dw) => waccBase + dw),
        rows: steps.map((dg) => ({ tg: tg + dg, values: steps.map((dw) => {
          const r = dcf(d, { wacc: dw, tg: dg }, null, waccBase);
          return !r || r.error ? null : r.perShare;
        }) })),
      };
    }
    return out;
  }

  return { compute, dcf, waccOf, tickSize, floorTick, num, CATEGORY_BAND, DEFAULT_SCEN, DEFAULT_WEIGHTS, DEFAULT_POSITION };
})();
if (typeof module !== "undefined") module.exports = FV;
