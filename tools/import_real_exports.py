#!/usr/bin/env python3
"""
Convertit les exports réels d'un incident M365 en événements de scénario Obliguard pseudonymisés.

Sources acceptées (autodétectées par les en-têtes, séparateur , ou ;) :
  - Export portail Entra « Journaux de connexion » (interactif / non interactif), en-têtes FR ou EN
  - Trace des messages (Received, SenderAddress, RecipientAddress, Subject, Status, FromIP, MessageId)
  - UAL exporté par Audit-M365-*.ps1 (111_target_ual_all.csv, 90_ual_config_changes.csv)
  - Audit Entra exporté par Audit-M365-*.ps1 (30_entra_directory_audit.csv)
  - Synthèse IP du script (140_target_ips.csv) : enrichit le bloc geo (hébergeur, proxy, mobile)

Pseudonymisation (HMAC-SHA256, clé secrète, déterministe d'un run à l'autre avec la même clé) :
  - UPN : local-part -> u-<hash> ou nom de rôle fourni par --roles ; domaine client -> --tenant-domain
  - domaines externes -> ext-<hash>.example
  - IP Microsoft (préfixes AS8075 connus) conservées ; autres IP -> 2001:db8:4:<h>::<hôte> pour l'IPv4
    (le /24 est préservé), 2001:db8:6:<h>::<h> pour l'IPv6 (le /64 est préservé)
  - objets : remplacés par subject-<hash> sauf ceux qui matchent --keep-subject (regex, répétable)
  - identifiants de session, de corrélation et d'appareil : hachés (les égalités sont préservées)
La table de correspondance réelle est écrite dans --private-map. Ce fichier ne doit JAMAIS être commité.

Étiquetage : --labels labels.json
  {"attackerIps": ["1.2.3.4", "2001:db8:bad::/48"], "legitIps": [...], "unknownIps": [...],
   "attackerUserAgents": ["python-requests"], "attackerSubjects": ["Vendor Service Agreement"]}
  Les IP sont données en clair : l'étiquetage se fait avant la pseudonymisation.

Usage :
  python3 import_real_exports.py --key-file ~/.obliguard_fixture_key --tenant-domain real-client.fr \\
     --pseudo-domain tenant-c.example --roles roles.json --labels labels.json \\
     --keep-subject "Vendor Service Agreement" --out events_observed.json --private-map ~/private_map.json \\
     InteractiveSignIns.csv NonInteractiveSignIns.csv trace_detail.csv 111_target_ual_all.csv 140_target_ips.csv
Le fichier --out contient {"events": [...], "geo": {...}} à fusionner dans scenario.json.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import ipaddress
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MS_PREFIXES = [ipaddress.ip_network(n) for n in (
    "13.64.0.0/11", "13.104.0.0/14", "20.0.0.0/8", "23.96.0.0/13", "40.64.0.0/10", "40.96.0.0/12", "40.104.0.0/15",
    "40.107.0.0/16", "51.4.0.0/15", "51.104.0.0/15", "52.0.0.0/10", "52.96.0.0/12", "52.112.0.0/14", "52.120.0.0/14",
    "104.40.0.0/13", "104.146.0.0/15", "104.208.0.0/13", "131.253.0.0/16", "132.245.0.0/16", "137.116.0.0/14",
    "150.171.0.0/16", "157.54.0.0/15", "157.56.0.0/14", "191.232.0.0/13", "204.79.197.0/24",
    "2603:1000::/24", "2620:1ec::/36", "2a01:111::/32")]
HEADER_ALIASES = {
    "ts": ["Date (UTC)", "Date", "Received", "CreationDate", "activityDateTime"],
    "user": ["Nom d'utilisateur", "Username", "User", "UPN", "SenderAddress"],
    "ip": ["Adresse IP", "IP address", "ClientIP", "IP", "FromIP"],
    "location": ["Emplacement", "Location"],
    "asn": ["Numéro de système autonome", "Autonomous system number", "ASN"],
    "status": ["Statut", "Status"],
    "app": ["Application"],
    "appId": ["ID d'application", "Application ID", "AppId"],
    "resource": ["Ressource", "Resource"],
    "ua": ["Agent utilisateur", "User agent", "UA", "UserAgent"],
    "authReq": ["Exigence d'authentification", "Authentication requirement"],
    "mfa": ["Méthode d'authentification multifacteur", "Multifactor authentication auth method"],
    "session": ["ID de session", "Session ID", "SessionId"],
    "device": ["ID de l'appareil", "Device ID"],
    "os": ["Système d'exploitation", "Operating System"],
    "browser": ["Navigateur", "Browser"],
    "error": ["Code d'erreur de connexion", "Sign-in error code"],
    "protocol": ["Protocole d'authentification", "Authentication Protocol"],
    "transfer": ["Méthode de transfert d'origine", "Original transfer method"],
    "crossTenant": ["Type d'accès client croisée", "Cross tenant access type"],
    "clientApp": ["Application cliente", "Client app"],
}


def norm(h: str) -> str:
    return re.sub(r"\s+", " ", h.replace("’", "'").replace("﻿", "")).strip().lower()


class Pseudo:
    def __init__(self, key: bytes, tenant_domain: str, pseudo_domain: str, roles: dict, keep_subjects: list[str]):
        self.key, self.td, self.pd = key, tenant_domain.lower(), pseudo_domain
        self.roles = {k.lower(): v for k, v in roles.items()}
        self.keep = [re.compile(k, re.I) for k in keep_subjects]
        self.map: dict[str, dict[str, str]] = {"upn": {}, "domain": {}, "ip": {}, "id": {}, "subject": {}}

    def h(self, s: str, n: int = 8) -> str:
        return hmac.new(self.key, s.encode(), hashlib.sha256).hexdigest()[:n]

    def domain(self, d: str) -> str:
        d = d.lower()
        if d == self.td:
            return self.pd
        return self.map["domain"].setdefault(d, f"ext-{self.h('d:' + d, 6)}.example")

    def upn(self, u: str | None) -> str | None:
        if not u or "@" not in u:
            return u
        ul = u.lower()
        if ul in self.map["upn"]:
            return self.map["upn"][ul]
        local, dom = ul.split("@", 1)
        pd = self.domain(dom)
        name = self.roles.get(ul) or (f"u-{self.h('u:' + ul, 6)}" if dom == self.td else f"c-{self.h('u:' + ul, 6)}")
        self.map["upn"][ul] = f"{name}@{pd}"
        return self.map["upn"][ul]

    def ip(self, raw: str | None) -> str | None:
        if not raw:
            return raw
        s = raw.strip().strip("[]")
        s = re.sub(r"^(\d+\.\d+\.\d+\.\d+):\d+$", r"\1", s)
        try:
            a = ipaddress.ip_address(s)
        except ValueError:
            return raw
        if any(a in n for n in MS_PREFIXES) or s == "255.255.255.255":
            return s
        if s in self.map["ip"]:
            return self.map["ip"][s]
        if a.version == 4:
            net = ".".join(s.split(".")[:3])
            out = f"2001:db8:4:{self.h('n4:' + net, 4)}::{s.split('.')[3]}"
        else:
            net64 = ipaddress.ip_network(f"{a}/64", strict=False)
            out = f"2001:db8:6:{self.h('n6:' + str(net64), 4)}::{self.h('h6:' + s, 4)}"
        self.map["ip"][s] = out
        return out

    def ident(self, v: str | None) -> str | None:
        if not v:
            return v
        return self.map["id"].setdefault(v, f"id-{self.h('i:' + v, 16)}")

    def subject(self, v: str | None) -> str | None:
        if not v or any(k.search(v) for k in self.keep):
            return v
        return self.map["subject"].setdefault(v, f"subject-{self.h('s:' + v, 6)}")


def read_rows(path: Path):
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    delim = ";" if raw.splitlines()[0].count(";") > raw.splitlines()[0].count(",") else ","
    return list(csv.DictReader(raw.splitlines(), delimiter=delim))


def col(row: dict, key: str):
    wanted = {norm(x) for x in HEADER_ALIASES[key]}
    for k, v in row.items():
        if k and norm(k) in wanted and v not in (None, ""):
            return v
    return None


def parse_ts(v: str | None) -> str | None:
    if not v:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %I:%M:%S %p"):
        try:
            d = datetime.strptime(v.strip()[:26] if "T" in v and "." in v else v.strip(), fmt)
            return d.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def kind_of(rows: list[dict], name: str) -> str:
    h = {norm(k) for k in rows[0].keys()} if rows else set()
    if "recipientaddress" in h:
        return "trace"
    if "operation" in h and "workload" in h:
        return "ual"
    if "activite" in h or "activité" in h:
        return "audit"
    if {"ip", "succes", "echecs"} <= h:
        return "ipsummary"
    if any(x in h for x in ("adresse ip", "ip address")):
        return "signin"
    raise SystemExit(f"{name} : format non reconnu ({sorted(h)[:8]})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--key-file", required=True, type=Path, help="clé HMAC (créée si absente)")
    ap.add_argument("--tenant-domain", required=True)
    ap.add_argument("--pseudo-domain", required=True)
    ap.add_argument("--roles", type=Path, help='{"real@client.fr": "victim", ...}')
    ap.add_argument("--labels", type=Path)
    ap.add_argument("--keep-subject", action="append", default=[])
    ap.add_argument("--timezone-local", default=None, help="non utilisé : les exports doivent être en UTC")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--private-map", required=True, type=Path)
    a = ap.parse_args()

    if not a.key_file.exists():
        import secrets
        a.key_file.write_text(secrets.token_hex(32))
        a.key_file.chmod(0o600)
    key = bytes.fromhex(a.key_file.read_text().strip())
    roles = json.loads(a.roles.read_text()) if a.roles else {}
    labels = json.loads(a.labels.read_text()) if a.labels else {}
    P = Pseudo(key, a.tenant_domain, a.pseudo_domain, roles, a.keep_subject)

    def nets(k):
        return [ipaddress.ip_network(x, strict=False) for x in labels.get(k, [])]
    atk_n, leg_n, unk_n = nets("attackerIps"), nets("legitIps"), nets("unknownIps")
    atk_ua = [re.compile(x, re.I) for x in labels.get("attackerUserAgents", [])]
    atk_subj = [re.compile(x, re.I) for x in labels.get("attackerSubjects", [])]

    def label(ip, ua, subject=None):
        if subject and any(r.search(subject) for r in atk_subj):
            return "attacker"
        try:
            ad = ipaddress.ip_address((ip or "").strip("[]"))
        except ValueError:
            ad = None
        if ad and any(ad in n for n in atk_n):
            return "attacker"
        if ua and any(r.search(ua) for r in atk_ua):
            return "attacker"
        if ad and any(ad in n for n in leg_n):
            return "legit"
        if ad and any(ad in n for n in unk_n):
            return "unknown"
        return "unknown"

    events, geo, n = [], {}, 0
    for f in a.files:
        rows = read_rows(f)
        if not rows:
            continue
        k = kind_of(rows, f.name)
        for r in rows:
            if k == "ipsummary":
                ip = P.ip(r.get("IP"))
                geo[ip] = {"country": r.get("Pays") or None, "city": r.get("Ville") or None, "asn": r.get("ASN") or None,
                           "org": r.get("ISP") or None,
                           "type": "microsoft" if r.get("Microsoft") == "True" else "hosting" if r.get("Hebergeur") == "True"
                           else "mobile" if r.get("Mobile") == "True" else "unknown",
                           "proxy": r.get("Proxy") == "True"}
                continue
            n += 1
            ip_raw = col(r, "ip")
            ua = col(r, "ua")
            base = {"id": f"obs-{n:07d}", "ts": parse_ts(col(r, "ts")), "label": label(ip_raw, ua, r.get("Subject")), "provenance": "observed",
                    "ip": P.ip(ip_raw)}
            if k == "signin":
                loc = [x.strip() for x in (col(r, "location") or "").split(",") if x.strip()]
                if base["ip"] and base["ip"] not in geo:
                    geo[base["ip"]] = {"country": loc[-1] if loc else None, "city": loc[0] if len(loc) > 1 else None,
                                       "asn": col(r, "asn"), "org": None, "type": "unknown"}
                err = col(r, "error")
                st = (col(r, "status") or "").lower()
                base.update(source="signin", user=P.upn(col(r, "user")), interactive="NonInteractive" not in f.name,
                            appId=col(r, "appId"), appName=col(r, "app"), resource=col(r, "resource"), clientApp=col(r, "clientApp"),
                            userAgent=ua, errorCode=int(err) if err and err.isdigit() else (0 if st.startswith(("succ", "réus")) else -1),
                            authRequirement=col(r, "authReq"), mfaMethod=col(r, "mfa"),
                            authProtocol={"device code": "deviceCode", "ropc": "ropc"}.get((col(r, "protocol") or "").lower(), "none"),
                            originalTransferMethod=col(r, "transfer"), sessionId=P.ident(col(r, "session")),
                            deviceId=P.ident(col(r, "device")), os=col(r, "os"), browser=col(r, "browser"),
                            crossTenantAccessType=col(r, "crossTenant"))
            elif k == "trace":
                snd, rcp = r.get("SenderAddress"), r.get("RecipientAddress")
                tdl = a.tenant_domain.lower()
                direction = "internal" if (snd or "").lower().endswith(tdl) and (rcp or "").lower().endswith(tdl) else \
                    "outbound" if (snd or "").lower().endswith(tdl) else "inbound"
                base.update(source="message_trace", sender=P.upn(snd), recipient=P.upn(rcp), subject=P.subject(r.get("Subject")),
                            status=r.get("Status"), fromIp=P.ip(r.get("FromIP")), direction=direction,
                            messageId=P.ident(r.get("MessageId")))
                base.pop("ip")
            elif k == "ual":
                base.update(source="ual", user=P.upn(r.get("User")), operation=r.get("Operation"), workload=r.get("Workload"),
                            resultStatus=r.get("Result"), clientInfo=ua, mailAccessType=r.get("AccessType") or None,
                            sessionId=P.ident(r.get("SessionId")), params="(détail retiré à l'import)")
            elif k == "audit":
                base.update(source="entra_audit", activity=r.get("Activite") or r.get("Activité"), category=r.get("Categorie"),
                            result=r.get("Resultat"), initiatedBy=P.upn(r.get("Initiateur")), target=P.upn(r.get("Cible")),
                            targetType=r.get("TypeCible"))
            events.append({k2: v for k2, v in base.items() if v not in (None, "")})

    events.sort(key=lambda e: (e.get("ts") or "", e["id"]))
    a.out.write_text(json.dumps({"events": events, "geo": geo}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    a.private_map.write_text(json.dumps(P.map, ensure_ascii=False, indent=1), encoding="utf-8")
    a.private_map.chmod(0o600)
    leaks = [v for v in (a.tenant_domain,) if v.lower() in a.out.read_text(encoding="utf-8").lower()]
    print(f"{len(events)} événements, {len(geo)} IP -> {a.out}")
    print(f"table de correspondance (hors dépôt) -> {a.private_map}")
    if leaks:
        print(f"ATTENTION : le domaine réel apparaît encore dans la sortie : {leaks}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
