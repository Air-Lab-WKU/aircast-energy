#!/usr/bin/env python3
"""Build static-site JSON/CSV for the probabilistic demand-forecast website.

Reads issue folders  <issues-dir>/<YYYY-MM-DD>/{forecast.csv, summary.json}
plus BA metadata     <issues-dir>/selection.csv   (or --selection PATH)
and writes           <out>/issues.json, <out>/<issue>/*.json|csv, <out>/latest/{summary,risk}.json

Date convention (verified against code/scripts/forecast_system_pilot.py on airlab):
  lead L <-> valid date issue + L days, so d1 = issue + 1 day ... d14 = issue + 14 days;
  w_k covers days 7(k-1)+1 .. 7k after issue (w1 = issue+1 .. issue+7);
  weekly peak = max of the 7 daily peaks (MW), weekly energy = sum of the 7 daily energies (MWh).
  Days are local-standard-time days of the BA.

Usage:
  python -I build_site.py --issues-dir sample --out site/data            # replay issues
  python -I build_site.py --issues-dir forecasts/live/interim --out site/data --live --stale-after-days 2

Standard library + pandas/numpy. No network access.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd

LOG = logging.getLogger("build_site")

QCOLS = [f"q{int(round(5 * i)):02d}" for i in range(1, 20)]           # q05..q95
QKEYS = [c[1:] for c in QCOLS]                                          # "05".."95"
LEVELS = ["90", "95", "99"]
DAILY = [f"d{d}" for d in range(1, 15)]
WEEKLY = [f"w{k}" for k in range(1, 7)]
RISK_LEADS = DAILY + ["w1", "w2"]
TARGETS = ["peak", "energy"]
UNITS = {"peak": "MW", "energy": "MWh"}
MODEL = "operational_v1"
EXPECTED_BAS = 29
REPLAY_LABELS = {
    "2023-08-07": "Replay: Aug 2023 heat",
    "2024-01-15": "Replay: Jan 2024 Arctic outbreak",
    "2024-06-17": "Replay: Jun 2024 heat",
    "2025-01-13": "Replay: Jan 2025 cold",
}
FLAG_NOTE = "no live EIA-930 demand for this BA; forecast level not anchored to recent observations, use with caution"
FORBIDDEN = ("secret", "token", "api_key")
# broader scrub (security review): credentials, server paths, hosts, IPv4, emails, well-known key prefixes
SCRUB_RE = re.compile(
    r"(secret|token|api[_-]?key|passw(or)?d|/media/|/home/|/mnt/|[a-z]:\\users|\.env\b|\bssh-|"
    r"ghp_[A-Za-z0-9]{10,}|github_pat_|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|"
    r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?!\d)|[\w.+-]+@[\w-]+\.[\w.-]+)", re.I)
SCRUB_ALLOW_EMAIL = ("manmeet.singh@wku.edu",)
ISSUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BA_RE = re.compile(r"^[A-Z0-9]{2,8}$")            # balancing-authority codes; used in file names
MAX_CSV_BYTES = 25_000_000
MAX_SUMMARY_BYTES = 100_000
# only these columns are ever published (forecast_all.csv is rebuilt from them, never copied verbatim)
PUBLIC_COLS = (["issue", "ba", "target", "unit", "observed", "lag_obs_missing"]
               + [f"q{p:02d}" for p in range(5, 100, 5)] + ["t90", "t95", "t99", "p_gt_t90", "p_gt_t95", "p_gt_t99"])


def csv_safe(v):
    """neutralise spreadsheet formula injection in text cells."""
    return ("'" + v) if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


# ----------------------------------------------------------------------------- helpers
def clean(x, nd=None):
    """float/np scalar -> rounded python float, NaN/inf/empty -> None."""
    if x is None:
        return None
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    if nd is None:
        return v
    v = round(v, nd)
    return int(v) if nd == 0 else v


def val_nd(target: str) -> int:
    return 1 if target == "peak" else 0          # MW to 0.1, MWh to 1


def lead_dates(issue: pd.Timestamp, unit: str) -> tuple[str, str]:
    """(start, end) valid dates (inclusive) of a lead unit."""
    if unit.startswith("d"):
        d = issue + pd.Timedelta(days=int(unit[1:]))
        return d.strftime("%Y-%m-%d"), d.strftime("%Y-%m-%d")
    k = int(unit[1:])
    s = issue + pd.Timedelta(days=7 * (k - 1) + 1)
    e = issue + pd.Timedelta(days=7 * k)
    return s.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    path.write_text(txt, encoding="utf-8")


def parse_bool(s) -> bool | None:
    if isinstance(s, (bool, np.bool_)):
        return bool(s)
    if s is None or (isinstance(s, float) and math.isnan(s)):
        return None
    t = str(s).strip().lower()
    if t in ("true", "1", "yes"):
        return True
    if t in ("false", "0", "no"):
        return False
    return None


# ----------------------------------------------------------------------------- loading / validation
def load_selection(path: Path) -> dict:
    s = pd.read_csv(path)
    meta = {}
    for _, r in s.iterrows():
        ba = str(r["unit"]).strip()
        meta[ba] = {
            "name": str(r.get("name", ba)).strip(),
            "lat": clean(r.get("centroid_lat"), 4),
            "lon": clean(r.get("centroid_lon"), 4),
            "tier": None if pd.isna(r.get("tier")) else str(r.get("tier")).strip(),
            "peak_class": None if pd.isna(r.get("peak_class")) else str(r.get("peak_class")).strip(),
        }
    return meta


def load_issue(folder: Path, stats: dict) -> tuple[pd.DataFrame, dict]:
    if (folder / "forecast.csv").stat().st_size > MAX_CSV_BYTES:
        raise SystemExit(f"{folder}: forecast.csv too large")
    df = pd.read_csv(folder / "forecast.csv")
    df["ba"] = df["ba"].astype(str).str.strip()
    bad_ba = sorted({b for b in df["ba"].unique() if not BA_RE.match(b)})
    if bad_ba:      # BA codes become file names: refuse anything that is not a plain code
        raise SystemExit(f"{folder.name}: invalid BA code(s) {bad_ba[:5]!r}; expected {BA_RE.pattern}")
    meta = {}
    sj = folder / "summary.json"
    if sj.exists():
        if sj.stat().st_size > MAX_SUMMARY_BYTES:
            raise SystemExit(f"{folder}: summary.json too large")
        raw = json.loads(sj.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise SystemExit(f"{folder}: summary.json is not an object")
        # keep only expected, type-checked fields
        meta = {
            "label": str(raw["label"])[:200] if isinstance(raw.get("label"), str) else None,
            "mode": str(raw["mode"])[:20] if isinstance(raw.get("mode"), str) else None,
            "members": raw["members"] if isinstance(raw.get("members"), int) and not isinstance(raw.get("members"), bool) else None,
            "data_cutoff": str(raw["data_cutoff"])[:40] if isinstance(raw.get("data_cutoff"), str) else None,
            "units": [u for u in raw["units"] if isinstance(u, str) and re.fullmatch(r"[dw]\d{1,2}", u)]
                     if isinstance(raw.get("units"), list) else None,
        }
        meta = {k: v for k, v in meta.items() if v is not None}
    issue = folder.name
    bad_issue = (df["issue"].astype(str) != issue).sum()
    if bad_issue:
        LOG.warning("%s: %d rows whose issue column != folder name", issue, bad_issue)

    # structure
    bas = sorted(df["ba"].unique())
    if len(bas) != EXPECTED_BAS:
        LOG.warning("%s: %d BAs present (expected %d)", issue, len(bas), EXPECTED_BAS)
    for ba in bas:
        g = df[df["ba"] == ba]
        for tg in TARGETS:
            have = set(g.loc[g["target"] == tg, "unit"])
            expected = meta.get("units") or (DAILY + WEEKLY)
            miss = [u for u in expected if u not in have]
            if miss:
                LOG.warning("%s %s %s: missing units %s", issue, ba, tg, miss)
    dup = df.duplicated(["ba", "target", "unit"]).sum()
    if dup:
        LOG.warning("%s: %d duplicate (ba,target,unit) rows; keeping first", issue, dup)
        df = df.drop_duplicates(["ba", "target", "unit"])

    # quantile monotonicity: sort row-wise
    q = df[QCOLS].to_numpy(dtype="float64")
    with np.errstate(invalid="ignore"):
        nonmono = (np.diff(q, axis=1) < 0).any(axis=1)
    n_nm = int(nonmono.sum())
    if n_nm:
        LOG.warning("%s: %d rows with non-monotone quantiles -> sorted", issue, n_nm)
        qs = np.sort(q, axis=1)                    # NaNs go last; fine for reporting
        df.loc[:, QCOLS] = qs
    stats.setdefault("nonmonotone_rows", {})[issue] = n_nm

    # other sanity checks (warn only)
    t = df[["t90", "t95", "t99"]].to_numpy(dtype="float64")
    p = df[["p_gt_t90", "p_gt_t95", "p_gt_t99"]].to_numpy(dtype="float64")
    with np.errstate(invalid="ignore"):
        n_t = int(((t[:, 0] > t[:, 1]) | (t[:, 1] > t[:, 2])).sum())
        n_p = int(((p[:, 0] < p[:, 1] - 1e-9) | (p[:, 1] < p[:, 2] - 1e-9)).sum())
        n_r = int(((p < -1e-9) | (p > 1 + 1e-9)).sum())
    for n, what in ((n_t, "thresholds not t90<=t95<=t99"), (n_p, "probabilities not p90>=p95>=p99"),
                    (n_r, "probabilities outside [0,1]")):
        if n:
            LOG.warning("%s: %d rows with %s", issue, n, what)
    n_nan = int(df[QCOLS].isna().any(axis=1).sum())
    if n_nan:
        LOG.warning("%s: %d rows with missing quantiles (written as null)", issue, n_nan)
    for tg in TARGETS:
        n_t = int(df.loc[df["target"] == tg, "p_gt_t90"].isna().sum())
        if n_t:
            LOG.info("%s: %s has %d rows without thresholds/exceedance probabilities (null)", issue, tg, n_t)

    lag = df["lag_obs_missing"].map(parse_bool) if "lag_obs_missing" in df else pd.Series(None, index=df.index)
    df["lag_obs_missing"] = lag
    lag_bas = sorted(df.loc[lag == True, "ba"].unique())  # noqa: E712
    if lag_bas:
        LOG.info("%s: lag_obs_missing=True for BAs %s", issue, lag_bas)
    stats.setdefault("lag_obs_missing_bas", {})[issue] = lag_bas
    obs_missing = sorted(df.loc[df["observed"].isna() & df["unit"].isin(DAILY), "ba"].unique())
    stats.setdefault("observed_missing_bas", {})[issue] = obs_missing
    return df, meta


# ----------------------------------------------------------------------------- builders
def lead_record(r, tg: str, unit: str, issue_ts: pd.Timestamp) -> dict:
    nd = val_nd(tg)
    s, e = lead_dates(issue_ts, unit)
    rec = {"lead": int(unit[1:])}
    if unit.startswith("d"):
        rec["date"] = s
    else:
        rec["week_start"], rec["week_end"] = s, e
    rec["observed"] = clean(r["observed"], nd) if r is not None else None
    rec["lag_obs_missing"] = (r["lag_obs_missing"] if r is not None and r["lag_obs_missing"] is not None else None)
    rec["q"] = {k: (clean(r[c], nd) if r is not None else None) for k, c in zip(QKEYS, QCOLS)}
    rec["t"] = {lv: (clean(r[f"t{lv}"], nd) if r is not None else None) for lv in LEVELS}
    rec["p"] = {lv: (clean(r[f"p_gt_t{lv}"], 4) if r is not None else None) for lv in LEVELS}
    return rec


def build_ba(ba: str, g: pd.DataFrame, issue: str, meta: dict) -> dict:
    issue_ts = pd.Timestamp(issue)
    idx = {(r["target"], r["unit"]): r for _, r in g.iterrows()}
    targets = {}
    for tg in TARGETS:
        targets[tg] = {
            "d": [lead_record(idx.get((tg, u)), tg, u, issue_ts) for u in DAILY],
            "w": [lead_record(idx.get((tg, u)), tg, u, issue_ts) for u in WEEKLY if (tg, u) in idx],
        }
    return {"ba": ba, "name": meta.get("name", ba), "issue": issue, "units": dict(UNITS),
            "energy_note": "daily energy in MWh per day; weekly energy = sum of 7 days (MWh per week)",
            "targets": targets}


def build_risk(df: pd.DataFrame, issue: str, bas: list[str]) -> dict:
    issue_ts = pd.Timestamp(issue)
    out = {"issue": issue, "leads": RISK_LEADS,
           "lead_dates": [list(lead_dates(issue_ts, u)) for u in RISK_LEADS],
           "targets": TARGETS, "bas": bas,
           "prob_targets": [tg for tg in TARGETS if df.loc[df["target"] == tg, "p_gt_t90"].notna().any()]}
    piv = {}
    for lv in LEVELS:
        cells = {}
        for tg in TARGETS:
            sub = df[df["target"] == tg].pivot(index="ba", columns="unit", values=f"p_gt_t{lv}")
            sub = sub.reindex(index=bas, columns=RISK_LEADS)
            cells[tg] = {ba: [clean(v, 4) for v in sub.loc[ba].tolist()] for ba in bas}
        piv[lv] = cells
    out["cells"] = piv["90"]
    out["cells_p95"] = piv["95"]
    out["cells_p99"] = piv["99"]
    return out


def fmt_day(date_str: str) -> str:
    d = dt.date.fromisoformat(date_str)
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"


def build_notable(df: pd.DataFrame, issue: str, n: int = 5, floor: float = 0.3, exclude=()) -> list[str]:
    """Top-n BAs by their highest P(peak > top-10% level) over d1-d14,w1,w2 (one line per BA)."""
    issue_ts = pd.Timestamp(issue)
    sub = df[(df["target"] == "peak") & df["unit"].isin(RISK_LEADS) & ~df["ba"].isin(list(exclude))]
    sub = sub.dropna(subset=["p_gt_t90"])
    if sub.empty:
        return ["No exceedance probabilities available for this issue."]
    best = sub.sort_values("p_gt_t90", ascending=False).drop_duplicates("ba").head(n)
    lines = []
    for _, r in best.iterrows():
        p = float(r["p_gt_t90"])
        if p < floor:
            continue
        s, e = lead_dates(issue_ts, r["unit"])
        when = f"{r['unit']} ({fmt_day(s)})" if r["unit"].startswith("d") else f"{r['unit']} ({fmt_day(s)} to {fmt_day(e)})"
        # how many leads at/above the floor for context
        nlead = int((sub[(sub["ba"] == r["ba"])]["p_gt_t90"] >= 0.5).sum())
        tail = f"; {nlead} of {len(RISK_LEADS)} leads at 50% or more" if nlead > 1 else ""
        lines.append(f"{r['ba']}: {round(100 * p)}% chance {when} peak exceeds its top-10% level{tail}")
    if not lines:
        lines.append(f"No BA has more than a {round(100 * floor)}% chance of a peak above its top-10% level in d1-w2.")
    return lines


def build_summary(df: pd.DataFrame, issue: str, info: dict, sel: dict, bas: list[str]) -> dict:
    rows = []
    for ba in bas:
        g = df[df["ba"] == ba]
        m = sel.get(ba, {})
        rr = g[g["unit"].isin(RISK_LEADS)].dropna(subset=["p_gt_t90"])
        if len(rr):
            top = rr.loc[rr["p_gt_t90"].idxmax()]
            max_p90 = {"lead": top["unit"], "target": top["target"], "p": clean(top["p_gt_t90"], 4)}
        else:
            max_p90 = {"lead": None, "target": None, "p": None}
        rp = g[g["target"] == "peak"].dropna(subset=["p_gt_t90"])
        rp = rp[rp["unit"].isin(RISK_LEADS)]
        max_p90_peak = ({"lead": rp.loc[rp["p_gt_t90"].idxmax(), "unit"], "p": clean(rp["p_gt_t90"].max(), 4)}
                        if len(rp) else {"lead": None, "p": None})

        def cell(tg, u, col, nd):
            x = g[(g["target"] == tg) & (g["unit"] == u)]
            return clean(x.iloc[0][col], nd) if len(x) else None
        lag = g["lag_obs_missing"]
        rows.append({
            "ba": ba, "name": m.get("name", ba), "lat": m.get("lat"), "lon": m.get("lon"),
            "tier": m.get("tier"), "peak_class": m.get("peak_class"),
            "max_p90": max_p90, "max_p90_peak": max_p90_peak,
            "peak_d1_median_mw": cell("peak", "d1", "q50", 1),
            "peak_d1_q05_mw": cell("peak", "d1", "q05", 1),
            "peak_d1_q95_mw": cell("peak", "d1", "q95", 1),
            "peak_d1_t90_mw": cell("peak", "d1", "t90", 1),
            "peak_d1_observed_mw": cell("peak", "d1", "observed", 1),
            "energy_d1_median_mwh": cell("energy", "d1", "q50", 0),
            "lag_obs_missing": bool((lag == True).any()),  # noqa: E712
            "flag": info.get("flagged", {}).get(ba),
        })
    return {
        "issue": issue, "kind": info["kind"], "model": MODEL, "mode": info["mode"],
        "members": info.get("members"), "data_cutoff": info.get("data_cutoff"),
        "caveat": info.get("caveat"),
        "weekly_leads": sorted({u for u in df["unit"] if u.startswith("w")}, key=lambda u: int(u[1:])),
        "stale": False, "stale_since": None,
        "n_bas": len(bas), "units": dict(UNITS),
        "leads": RISK_LEADS,
        "lead_convention": "dN = issue + N days; wK = issue+7K-6 .. issue+7K (local standard time days)",
        "notable": build_notable(df, issue, exclude=list(info.get("flagged", {}))),
        "flagged_bas": info.get("flagged", {}),
        "bas": rows,
    }


def write_ba_csv(path: Path, g: pd.DataFrame, issue: str, tg_order=TARGETS) -> None:
    issue_ts = pd.Timestamp(issue)
    order = {u: i for i, u in enumerate(DAILY + WEEKLY)}
    g = g.copy()
    g["_t"] = g["target"].map({t: i for i, t in enumerate(tg_order)})
    g["_u"] = g["unit"].map(order)
    g = g.sort_values(["_t", "_u"]).drop(columns=["_t", "_u"])
    se = g["unit"].map(lambda u: lead_dates(issue_ts, u))
    g.insert(4, "valid_start", se.map(lambda x: x[0]))
    g.insert(5, "valid_end", se.map(lambda x: x[1]))
    g.insert(6, "value_unit", g["target"].map(UNITS))
    for c in QCOLS + ["observed", "t90", "t95", "t99"]:
        g[c] = [None if pd.isna(v) else round(float(v), val_nd(t)) for v, t in zip(g[c], g["target"])]
    for c in ["p_gt_t90", "p_gt_t95", "p_gt_t99"]:
        g[c] = g[c].round(4)
    g["lag_obs_missing"] = g["lag_obs_missing"].map(lambda v: "" if v is None else str(bool(v)))
    for c in g.columns:
        if g[c].dtype == object:
            g[c] = g[c].map(csv_safe)
    g.to_csv(path, index=False, lineterminator="\n")


def write_public_csv(path: Path, df: pd.DataFrame) -> None:
    """forecast_all.csv: whitelisted columns only, rounded, formula-safe (never a verbatim copy)."""
    cols = [c for c in PUBLIC_COLS if c in df.columns]
    g = df[cols].copy()
    for c in cols:
        if g[c].dtype == object:
            g[c] = g[c].map(csv_safe)
        elif pd.api.types.is_float_dtype(g[c]):
            g[c] = g[c].round(4 if c.startswith("p_gt") else 1)
    g.to_csv(path, index=False, lineterminator="\n")


# ----------------------------------------------------------------------------- main
def classify(df: pd.DataFrame, meta: dict, a) -> tuple[str, str]:
    """(kind, mode). live if --live, or summary.json says interim/s2s, or no observations at all."""
    tag = str(meta.get("mode") or meta.get("label") or "").lower()
    meta_mode = "interim" if tag.startswith("interim") else ("s2s" if tag.startswith("s2s") else None)
    if a.live or meta_mode or df["observed"].isna().all():
        return "live", meta_mode or a.mode
    return "replay", "replay"


def scrub(out: Path) -> None:
    hits = []
    for f in out.rglob("*"):
        if f.is_file() and f.suffix.lower() in (".json", ".csv", ".txt", ".md", ".html", ".js"):
            txt = f.read_text(encoding="utf-8", errors="replace")
            for m in SCRUB_RE.finditer(txt):
                if m.group(0).lower() in SCRUB_ALLOW_EMAIL:
                    continue
                hits.append(f"{f.name}: {m.group(0)[:30]!r}")
                break
    if hits:
        raise SystemExit("SCRUB FAILED (sensitive-looking strings in output):\n" + "\n".join(hits[:20]))
    LOG.info("scrub passed (credential/path/IP/email patterns) in %s", out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--issues-dir", required=True, type=Path, help="folder holding <YYYY-MM-DD>/forecast.csv")
    ap.add_argument("--out", required=True, type=Path, help="site/data output folder")
    ap.add_argument("--selection", type=Path, default=None, help="BA metadata csv (default <issues-dir>/selection.csv)")
    ap.add_argument("--live", action="store_true", help="treat issues as live forecasts (kind=live)")
    ap.add_argument("--mode", default="interim", choices=["interim", "s2s"], help="mode label for live issues")
    ap.add_argument("--stale-after-days", type=float, default=None,
                    help="mark newest live issue stale if older than this many days")
    ap.add_argument("--today", default=None, help="override today's date (YYYY-MM-DD) for the stale check")
    ap.add_argument("--flag-bas", default="AEC,SPPC",
                    help="comma list of BAs without live EIA demand; flagged and left out of notable in live issues")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(levelname)s %(message)s")

    sel_path = a.selection or (a.issues_dir / "selection.csv")
    sel = load_selection(sel_path) if sel_path.exists() else {}
    if not sel:
        LOG.warning("no BA metadata (%s); names/coords will be missing", sel_path)

    folders = sorted([p for p in a.issues_dir.iterdir() if p.is_dir() and ISSUE_RE.match(p.name)
                      and (p / "forecast.csv").exists()], key=lambda p: p.name, reverse=True)
    if not folders:
        raise SystemExit(f"no issue folders with forecast.csv under {a.issues_dir}")
    final_out: Path = a.out
    out: Path = final_out.with_name(final_out.name + ".build")   # build aside, swap in only if all checks pass
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    stats: dict = {}
    index = []
    summaries = {}

    for folder in folders:
        issue = folder.name
        df, meta = load_issue(folder, stats)
        kind, mode = classify(df, meta, a)
        info = {
            "kind": kind,
            "mode": mode,
            "caveat": meta.get("label"),
            "flagged": ({b: FLAG_NOTE for b in a.flag_bas.split(",") if b} if kind == "live" else {}),
            "members": meta.get("members"),
            "data_cutoff": meta.get("data_cutoff"),
        }
        bas = sorted(df["ba"].unique())
        missing_meta = [b for b in bas if b not in sel]
        if missing_meta:
            LOG.warning("%s: no metadata for %s", issue, missing_meta)
        d = out / issue
        d.mkdir(parents=True, exist_ok=True)
        for ba in bas:
            g = df[df["ba"] == ba]
            write_json(d / f"{ba}.json", build_ba(ba, g, issue, sel.get(ba, {})))
            write_ba_csv(d / f"{ba}.csv", g, issue)
        write_json(d / "risk.json", build_risk(df, issue, bas))
        summ = build_summary(df, issue, info, sel, bas)
        summaries[issue] = summ
        write_public_csv(d / "forecast_all.csv", df)
        label = REPLAY_LABELS.get(issue) if kind == "replay" else None
        label = label or (f"Live: {issue} ({info['mode']})" if kind == "live" else f"Replay: {issue}")
        index.append({"issue": issue, "kind": kind, "model": MODEL, "mode": info["mode"],
                      "n_bas": len(bas), "label": label})
        LOG.info("%s: %d BAs, %d rows written", issue, len(bas), len(df))

    # stale check (newest live issue only)
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone.utc).date()
    live = [s for s in index if s["kind"] == "live"]
    if a.stale_after_days is not None and live:
        newest = live[0]["issue"]
        age = (today - dt.date.fromisoformat(newest)).days
        if age > a.stale_after_days:
            summaries[newest]["stale"] = True
            summaries[newest]["stale_since"] = newest
            summaries[newest]["stale_age_days"] = age
            LOG.warning("newest live issue %s is %d days old -> stale", newest, age)
    for issue, s in summaries.items():
        write_json(out / issue / "summary.json", s)

    latest = index[0]["issue"]
    write_json(out / "issues.json", {"latest": latest,
                                     "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
                                     "issues": index})
    (out / "latest").mkdir(exist_ok=True)
    for f in ("summary.json", "risk.json"):
        shutil.copyfile(out / latest / f, out / "latest" / f)

    scrub(out)
    if final_out.exists():
        shutil.rmtree(final_out)
    shutil.move(str(out), str(final_out))
    out = final_out
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    LOG.info("non-monotone rows sorted: %s", stats.get("nonmonotone_rows"))
    LOG.info("lag_obs_missing BAs: %s", stats.get("lag_obs_missing_bas"))
    LOG.info("BAs with missing daily observed: %s", stats.get("observed_missing_bas"))
    LOG.info("done: latest=%s, %d issues, %.2f MB in %s", latest, len(index), total / 1e6, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
