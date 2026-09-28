#!/usr/bin/env python3
"""Check USGS elevated volcanoes + GDACS worldwide eruptions; notify on change."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "state.json"
UA = "volcano-watch/1.0 (+local monitor)"
TIMEOUT = 45

COLOR_RANK = {"GREEN": 0, "YELLOW": 1, "ORANGE": 2, "RED": 3, "": -1}
ALERT_RANK = {
    "NORMAL": 0,
    "UNASSIGNED": 0,
    "ADVISORY": 1,
    "WATCH": 2,
    "WARNING": 3,
    "": -1,
}


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def usgs_elevated() -> list[dict]:
    data = fetch_json("https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated")
    items = data if isinstance(data, list) else []
    out = []
    for i in items:
        name = i.get("vName") or i.get("volcano_name") or "Unknown"
        color = (i.get("colorCode") or i.get("color_code") or "").upper()
        alert = (i.get("alertLevel") or i.get("alert_level") or "").upper()
        synopsis = (i.get("noticeSynopsis") or i.get("notice_synopsis") or "").strip()
        obs = (i.get("obs") or "").lower()
        notice_url = i.get("noticeUrl") or i.get("notice_url") or ""
        key = f"usgs:{i.get('vnum') or i.get('volcanoCd') or name}"
        out.append(
            {
                "key": key,
                "source": "USGS",
                "name": name,
                "color": color,
                "alert": alert,
                "synopsis": synopsis,
                "obs": obs,
                "url": notice_url
                or f"https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated",
                "rank": max(COLOR_RANK.get(color, 0), ALERT_RANK.get(alert, 0)),
            }
        )
    return out


def gdacs_eruptions(days: int = 45) -> list[dict]:
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00")
    end = now.strftime("%Y-%m-%dT23:59:59")
    url = (
        "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
        f"?eventtypes=VO&fromdatetime={start}&todatetime={end}"
    )
    data = fetch_json(url)
    feats = data.get("features") or []
    out = []
    for f in feats:
        p = f.get("properties") or {}
        et = str(p.get("eventtype") or "").upper()
        name = str(p.get("name") or p.get("eventname") or "").strip()
        if et != "VO" and "eruption" not in name.lower() and "volcano" not in name.lower():
            continue
        alert = str(p.get("alertlevel") or p.get("alertLevel") or "").capitalize()
        color = alert.upper() if alert.upper() in COLOR_RANK else "ORANGE"
        eid = p.get("eventid") or p.get("episodeid") or name
        desc = (p.get("htmldescription") or p.get("description") or "").strip()
        # strip simple tags
        while "<" in desc and ">" in desc:
            a, b = desc.find("<"), desc.find(">")
            if a < 0 or b < 0 or b < a:
                break
            desc = desc[:a] + desc[b + 1 :]
        desc = " ".join(desc.split())
        link = p.get("url") or p.get("link") or "https://www.gdacs.org/"
        out.append(
            {
                "key": f"gdacs:{eid}:{name}",
                "source": "GDACS",
                "name": name,
                "color": color,
                "alert": alert.upper(),
                "synopsis": desc[:240],
                "from": p.get("fromdate") or "",
                "url": link,
                "rank": COLOR_RANK.get(color, 1),
            }
        )
    # keep most severe / newest-ish unique by name
    by_name: dict[str, dict] = {}
    for item in out:
        n = item["name"].lower()
        prev = by_name.get(n)
        if prev is None or item["rank"] >= prev["rank"]:
            by_name[n] = item
    return list(by_name.values())


def fingerprint(items: list[dict]) -> dict[str, str]:
    fp = {}
    for i in items:
        fp[i["key"]] = f"{i.get('color','')}|{i.get('alert','')}|{(i.get('synopsis') or '')[:120]}"
    return fp


def summarize(items: list[dict]) -> str:
    if not items:
        return "No elevated USGS volcanoes and no recent GDACS eruption events."
    lines = []
    usgs = [i for i in items if i["source"] == "USGS"]
    gdacs = [i for i in items if i["source"] == "GDACS"]
    if usgs:
        lines.append("USGS elevated:")
        for i in sorted(usgs, key=lambda x: (-x["rank"], x["name"])):
            syn = i["synopsis"][:140] if i["synopsis"] else ""
            lines.append(f"- {i['name']} {i['color']}/{i['alert']}" + (f" — {syn}" if syn else ""))
    if gdacs:
        lines.append("GDACS worldwide eruptions (recent):")
        for i in sorted(gdacs, key=lambda x: (-x["rank"], x["name"])):
            syn = i["synopsis"][:140] if i["synopsis"] else ""
            lines.append(f"- {i['name']} {i['color']}" + (f" — {syn}" if syn else ""))
    return "\n".join(lines)


def main() -> int:
    errors = []
    usgs, gdacs = [], []
    try:
        usgs = usgs_elevated()
    except Exception as e:
        errors.append(f"USGS fetch failed: {e}")
    try:
        gdacs = gdacs_eruptions()
    except Exception as e:
        errors.append(f"GDACS fetch failed: {e}")

    items = usgs + gdacs
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    prev = load_state()
    prev_fp = prev.get("fingerprint") or {}
    cur_fp = fingerprint(items)

    added = [k for k in cur_fp if k not in prev_fp]
    removed = [k for k in prev_fp if k not in cur_fp]
    changed = [k for k in cur_fp if k in prev_fp and cur_fp[k] != prev_fp[k]]

    # Only notify on meaningful changes: new event, color/alert/synopsis change,
    # or removal of a previously elevated volcano. First run seeds state silently
    # unless there is an ORANGE/RED item (still seed, but report baseline once).
    first_run = not prev_fp
    notable_now = [i for i in items if i["rank"] >= 2]  # ORANGE/WATCH+

    notify = False
    reasons = []
    if first_run:
        # Baseline: always ping once so the user sees the monitor is live.
        notify = True
        reasons.append("baseline")
    else:
        if added:
            notify = True
            reasons.append(f"new:{len(added)}")
        if changed:
            notify = True
            reasons.append(f"changed:{len(changed)}")
        if removed:
            # demotions matter
            notify = True
            reasons.append(f"cleared:{len(removed)}")

    state = {
        "checked_at": now,
        "fingerprint": cur_fp,
        "items": items,
        "errors": errors,
        "last_notify_reasons": reasons if notify else prev.get("last_notify_reasons"),
    }
    save_state(state)

    result = {
        "ok": not errors or bool(items),
        "notify": notify,
        "reasons": reasons,
        "checked_at": now,
        "usgs_count": len(usgs),
        "gdacs_count": len(gdacs),
        "notable_orange_red": len(notable_now),
        "summary": summarize(items),
        "errors": errors,
        "links": {
            "usgs_elevated": "https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated",
            "usgs_dashboard": "https://www.usgs.gov/programs/VHP/volcano-updates",
            "gdacs": "https://www.gdacs.org/",
            "smithsonian_weekly": "https://volcano.si.edu/reports_weekly.cfm",
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
