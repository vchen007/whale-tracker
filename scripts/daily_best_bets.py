#!/usr/bin/env python3
"""
Daily Best Bets — Kalshi whale tracker email digest.

Fetches the last 24 hours of trades from the Kalshi public API, computes
two views (top conviction plays + top largest single bets), groups by
category, and emails an HTML digest via Resend.

Mirrors the prompt run by the scheduled remote agent
(trig_018DFBKwfZ2wniQ1vnAfCjjs). Update both in lockstep.

Usage:
  RESEND_API_KEY=re_xxx NOTIFY_EMAIL=you@example.com python3 scripts/daily_best_bets.py
"""
import json
import os
import time
import warnings
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import requests

warnings.filterwarnings("ignore")

# ── Config ────────────────────────────────────────────────────────────────────

BASE = "https://api.elections.kalshi.com/trade-api/v2"
MIN_TRADE_NOTIONAL = 100      # per-trade floor
MIN_CONFIDENCE     = 70       # min winning-side % to count as a "best bet"
TOP_BETS_LIMIT     = 25
TOP_LARGEST_LIMIT  = 5
TOP_TLDR_LIMIT     = 5

# Adaptive pair-notional thresholds — try in descending order and stop at the
# first level that yields ≥ MIN_BETS_TARGET qualifying markets. Ensures the
# email always has actionable content even on quiet days (e.g. Tuesdays
# between sports rounds, holidays, etc).
PAIR_THRESHOLD_TIERS = [50_000, 20_000, 10_000, 5_000, 2_000, 500]
MIN_BETS_TARGET      = 5

RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
NOTIFY_EMAIL   = os.environ.get("NOTIFY_EMAIL", "claude_bot23@proton.me")
NOTIFY_FROM    = os.environ.get("NOTIFY_FROM", "Whale Tracker <onboarding@resend.dev>")

# All 14 Kalshi top-level categories
CAT_EMOJI = {
    "Sports": "🏆",
    "Politics": "🏛️",
    "Elections": "🗳️",
    "Economics": "📊",
    "Financials": "💵",
    "Crypto": "₿",
    "Commodities": "🛢️",
    "Companies": "🏢",
    "Climate and Weather": "🌡️",
    "Health": "🏥",
    "Science and Technology": "🔬",
    "Entertainment": "🎬",
    "Social": "👥",
    "Mentions": "💬",
    "Other": "🎯",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt(n):
    if n >= 1_000_000: return f"${n/1_000_000:.2f}M"
    if n >= 1_000:     return f"${n/1_000:.0f}K"
    return f"${n:.0f}"


def side_color(side): return "#16a34a" if side == "YES" else "#dc2626"
def side_emoji(side): return "🟢" if side == "YES" else "🔴"


# ── 1. Fetch + analyze trades ────────────────────────────────────────────────

def fetch_and_analyze():
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    trades, cursor = [], None
    for i in range(60):
        params = {"limit": "1000", "min_created_time": since}
        if cursor: params["cursor"] = cursor
        r = requests.get(f"{BASE}/markets/trades", params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(5)  # backoff if rate-limited
            continue
        if r.status_code != 200:
            break
        data = r.json()
        batch = data.get("trades", [])
        if not batch: break
        trades.extend(batch)
        cursor = data.get("cursor")
        if not cursor: break
        if i > 0 and i % 5 == 0:
            time.sleep(0.3)  # gentle pacing every 5 pages
    print(f"Fetched {len(trades)} trades from Kalshi")

    # Top N largest single trades
    all_trades = []
    for t in trades:
        side  = t.get("taker_side", "")
        yes_p = float(t.get("yes_price_dollars") or 0)
        no_p  = float(t.get("no_price_dollars") or 0)
        price = yes_p if side == "yes" else no_p
        count = float(t.get("count_fp") or 0)
        notional = count * price
        all_trades.append({
            "ticker": t["ticker"], "side": side, "price": price,
            "count": count, "notional": notional, "time": t.get("created_time", ""),
        })
    all_trades.sort(key=lambda x: x["notional"], reverse=True)
    top_largest = all_trades[:TOP_LARGEST_LIMIT]

    # Aggregate per market (filtered to whale floor)
    markets = defaultdict(lambda: {"yes": 0.0, "no": 0.0, "trades": 0, "last_price": 0})
    for t in trades:
        side  = t.get("taker_side", "")
        yes_p = float(t.get("yes_price_dollars") or 0)
        no_p  = float(t.get("no_price_dollars") or 0)
        price = yes_p if side == "yes" else no_p
        count = float(t.get("count_fp") or 0)
        notional = count * price
        if notional < MIN_TRADE_NOTIONAL: continue
        m = markets[t["ticker"]]
        m[side] += notional
        m["trades"] += 1
        m["last_price"] = yes_p

    # Group sides into game-pairs (event_ticker = ticker minus last segment)
    pairs = defaultdict(list)
    for ticker, info in markets.items():
        event = "-".join(ticker.rsplit("-")[:-1]) or ticker
        pairs[event].append((ticker, info))

    # Compute candidate bets per pair (no min-notional filter yet)
    candidates = []
    for event, sides in pairs.items():
        total = sum(s[1]["yes"] + s[1]["no"] for s in sides)
        best_side, best_conf = None, 0
        for ticker, info in sides:
            side_total = info["yes"] + info["no"]
            if side_total == 0: continue
            yes_pct = 100 * info["yes"] / side_total
            winner_side = "YES" if yes_pct > 50 else "NO"
            conf = max(yes_pct, 100 - yes_pct)
            if conf > best_conf:
                best_conf, best_side = conf, (ticker, winner_side, conf, side_total)
        if best_conf < MIN_CONFIDENCE: continue
        if not best_side: continue
        ticker, winner_side, conf, side_total = best_side
        candidates.append({
            "event": event, "ticker": ticker, "winner_side": winner_side,
            "confidence": conf, "combined": total, "side_notional": side_total,
            "last_price": markets[ticker]["last_price"],
        })

    candidates.sort(key=lambda b: b["combined"], reverse=True)

    # Adaptive threshold: pick the highest tier yielding ≥ MIN_BETS_TARGET bets
    chosen_threshold = PAIR_THRESHOLD_TIERS[-1]
    best_bets = []
    for tier in PAIR_THRESHOLD_TIERS:
        bets_at_tier = [b for b in candidates if b["combined"] >= tier]
        if len(bets_at_tier) >= MIN_BETS_TARGET:
            chosen_threshold = tier
            best_bets = bets_at_tier
            break
    else:
        # No tier met the target — show all candidates anyway
        best_bets = candidates

    top = best_bets[:TOP_BETS_LIMIT]
    print(f"Adaptive threshold = ${chosen_threshold:,} → {len(top)} bets")

    # Fetch titles + categories for top bets
    for b in top:
        try:
            mr = requests.get(f"{BASE}/markets/{b['ticker']}", timeout=10).json()
            m = mr.get("market", {})
            b["title"]   = m.get("title", "") or b["ticker"]
            b["yes_sub"] = m.get("yes_sub_title", "")
            b["no_sub"]  = m.get("no_sub_title", "")
            er = requests.get(f"{BASE}/events/{b['event']}", timeout=10).json()
            b["category"] = er.get("event", {}).get("category", "Other")
        except Exception:
            b["title"] = b["ticker"]; b["category"] = "Other"
            b["yes_sub"] = ""; b["no_sub"] = ""

    # Reuse titles for top_largest (or fetch)
    cache = {b["ticker"]: (b["title"], b["yes_sub"], b["no_sub"]) for b in top}
    for t in top_largest:
        if t["ticker"] in cache:
            t["title"], t["yes_sub"], t["no_sub"] = cache[t["ticker"]]
        else:
            try:
                mr = requests.get(f"{BASE}/markets/{t['ticker']}", timeout=10).json()
                m = mr.get("market", {})
                t["title"]   = m.get("title", "") or t["ticker"]
                t["yes_sub"] = m.get("yes_sub_title", "")
                t["no_sub"]  = m.get("no_sub_title", "")
            except Exception:
                t["title"] = t["ticker"]
                t["yes_sub"] = ""; t["no_sub"] = ""

    by_cat = defaultdict(list)
    for b in top:
        by_cat[b["category"]].append(b)

    return {
        "date": datetime.now(timezone.utc).strftime("%b %d, %Y"),
        "total_whale_trades": sum(m["trades"] for m in markets.values()),
        "total_volume": sum(m["yes"] + m["no"] for m in markets.values()),
        "total_raw_trades": len(trades),
        "top_bets": top,
        "top_largest": top_largest,
        "by_category": dict(by_cat),
        "threshold_used": chosen_threshold,
    }


# ── 2. Build + send email ────────────────────────────────────────────────────

def build_html(r):
    # Column widths — forced layout so the right-aligned $ + % always lines up
    # across rows regardless of how long the title or pick text is.
    # Layout: # | Title | Pick | Amount(%)
    COL_RANK = '<col style="width:30px">'
    COL_TITLE = '<col>'                       # flexes
    COL_PICK = '<col style="width:170px">'
    COL_AMT = '<col style="width:130px">'
    COLS_4 = f'<colgroup>{COL_RANK}{COL_TITLE}{COL_PICK}{COL_AMT}</colgroup>'
    COLS_3 = f'<colgroup>{COL_TITLE}{COL_PICK}{COL_AMT}</colgroup>'
    TBL_STYLE = "width:100%;border-collapse:collapse;table-layout:fixed"
    CELL_TRUNC = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap"

    # Top 5 conviction plays
    tldr_rows = ""
    for i, b in enumerate(r["top_bets"][:TOP_TLDR_LIMIT], 1):
        pick = b["yes_sub"] if b["winner_side"] == "YES" else b["no_sub"]
        pick = pick or b["winner_side"]
        color = side_color(b["winner_side"])
        emoji = side_emoji(b["winner_side"])
        tldr_rows += (
            f'<tr>'
            f'<td style="padding:6px 8px 6px 0;color:#666">#{i}</td>'
            f'<td style="padding:6px 12px 6px 0;{CELL_TRUNC}"><b>{b["title"]}</b></td>'
            f'<td style="padding:6px 12px 6px 0;color:{color};{CELL_TRUNC}"><b>{emoji} {b["winner_side"]}: {pick}</b></td>'
            f'<td style="padding:6px 8px 6px 0;text-align:right;font-family:monospace;white-space:nowrap">{fmt(b["combined"])} · {b["confidence"]:.0f}%</td>'
            f'</tr>'
        )

    # Top 5 largest single bets
    largest_rows = ""
    for i, t in enumerate(r["top_largest"], 1):
        pick = t["yes_sub"] if t["side"] == "yes" else t["no_sub"]
        pick = pick or t["side"].upper()
        side_upper = t["side"].upper()
        color = side_color(side_upper)
        emoji = side_emoji(side_upper)
        largest_rows += (
            f'<tr>'
            f'<td style="padding:6px 8px 6px 0;color:#666;font-size:12px">#{i}</td>'
            f'<td style="padding:6px 12px 6px 0;font-size:13px;{CELL_TRUNC}"><b>{t["title"]}</b></td>'
            f'<td style="padding:6px 12px 6px 0;color:{color};font-weight:600;font-size:13px;{CELL_TRUNC}">{emoji} {side_upper}: {pick} @ {int(round(t["price"]*100))}¢</td>'
            f'<td style="padding:6px 8px 6px 0;text-align:right;font-family:monospace;font-size:13px;white-space:nowrap"><b>{fmt(t["notional"])}</b></td>'
            f'</tr>'
        )

    # Per-category sections
    cat_html = ""
    for cat, bets in sorted(r["by_category"].items(), key=lambda x: -sum(b["combined"] for b in x[1])):
        cat_emoji = CAT_EMOJI.get(cat, "🎯")
        rows = ""
        for b in bets:
            pick = b["yes_sub"] if b["winner_side"] == "YES" else b["no_sub"]
            pick = pick or b["winner_side"]
            color = side_color(b["winner_side"])
            emoji = side_emoji(b["winner_side"])
            rows += (
                f'<tr>'
                f'<td style="padding:5px 12px 5px 0;font-size:13px;{CELL_TRUNC}">{b["title"]}</td>'
                f'<td style="padding:5px 12px 5px 0;color:{color};font-weight:600;font-size:13px;{CELL_TRUNC}">{emoji} {b["winner_side"]}: {pick}</td>'
                f'<td style="padding:5px 8px 5px 0;text-align:right;font-family:monospace;font-size:13px;white-space:nowrap">{fmt(b["combined"])} · {b["confidence"]:.0f}%</td>'
                f'</tr>'
            )
        cat_html += (
            f'<h3 style="margin:20px 0 6px 0;color:#0a0a0a">{cat_emoji} {cat}</h3>'
            f'<table style="{TBL_STYLE}">{COLS_3}{rows}</table>'
        )

    # Volume / threshold banner — shown when activity is below the standard
    # bar so the user knows why the email is sparse (vs assuming bug).
    threshold = r.get("threshold_used", 50_000)
    is_quiet = threshold < 50_000 or len(r["top_bets"]) == 0
    quiet_banner = ""
    if is_quiet:
        if len(r["top_bets"]) == 0:
            msg = "🌙 No qualifying whale signals today — light trading volume across the board."
        else:
            msg = f"🌙 Light trading day — relaxed threshold to {fmt(threshold)} to surface signals (normal: $50K)."
        quiet_banner = (
            '<div style="background:#fff3cd;border-left:4px solid #ffa726;padding:10px 14px;'
            'margin:14px 0 4px 0;font-size:13px;color:#7a5b00;border-radius:4px">'
            f'{msg}'
            '</div>'
        )

    # Tables only render if there are rows to show
    tldr_section = (
        '<h3 style="margin-top:20px;color:#0a0a0a">🔥 Top 5 Conviction Plays</h3>'
        f'<table style="{TBL_STYLE};background:#f9f9f9;padding:8px">{COLS_4}{tldr_rows}</table>'
    ) if tldr_rows else (
        '<h3 style="margin-top:20px;color:#0a0a0a">🔥 Top 5 Conviction Plays</h3>'
        '<p style="color:#888;font-size:13px;font-style:italic;background:#f9f9f9;padding:14px;margin:0">'
        'No markets met the conviction filter today.</p>'
    )
    largest_section = (
        '<h3 style="margin-top:20px;color:#0a0a0a">💰 Top 5 Largest Single Bets</h3>'
        f'<table style="{TBL_STYLE};background:#fff8e1;padding:8px">{COLS_4}{largest_rows}</table>'
    ) if largest_rows else ""

    return f"""<div style="font-family:-apple-system,sans-serif;max-width:640px;color:#1a1a1a;padding:8px">
  <h2 style="color:#0a0a0a;border-bottom:2px solid #16a34a;padding-bottom:8px">🐳 Daily Best Bets — {r['date']}</h2>
  <p style="color:#666;font-size:13px">{r['total_whale_trades']:,} whale trades · {fmt(r['total_volume'])} total volume in last 24h</p>

  {quiet_banner}
  {tldr_section}
  {largest_section}

  {cat_html}

  <div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#999;font-size:11px;line-height:1.5">
    <div><b>Legend:</b> <span style="color:#16a34a;font-weight:600">🟢 YES</span> = whale buying YES (outcome will happen) · <span style="color:#dc2626;font-weight:600">🔴 NO</span> = whale buying NO (outcome will NOT happen)</div>
    <div style="margin-top:6px">Conviction = combined $ across both sides of a market with ≥{MIN_CONFIDENCE}% lean. Threshold used today: {fmt(threshold)} (adapts on quiet days). Largest = single biggest whale trades by notional. Source: Kalshi public trades API.</div>
  </div>
</div>"""


def send_email(html, date):
    if not RESEND_API_KEY:
        print("RESEND_API_KEY not set — printing HTML instead of sending")
        print(html[:500] + "...")
        return None
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
        json={
            "from": NOTIFY_FROM,
            "to": NOTIFY_EMAIL,
            "subject": f"🐳 Daily Best Bets — {date}",
            "html": html,
        },
    )
    print(f"Resend status: {resp.status_code} {resp.text[:200]}")
    return resp


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    result = fetch_and_analyze()
    largest = result["top_largest"][0]["notional"] if result["top_largest"] else 0
    print(f"Found {len(result['top_bets'])} best bets, top single trade: ${largest:,.0f}")
    html = build_html(result)
    send_email(html, result["date"])
