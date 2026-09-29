#!/usr/bin/env python3
"""
Génère les scénarios de rejeu M365 d'Obliguard à partir des deux incidents réels
de septembre 2026 (AiTM + jonction de postes, puis device code phishing).

Sortie : fixtures/m365/<scenario>/scenario.json, conforme à fixtures/m365/scenario.schema.json.

Toutes les données sont pseudonymisées :
  - domaines clients -> tenant-a.example / tenant-b.example
  - utilisateurs -> rôles fonctionnels
  - IP non Microsoft -> plages de documentation (192.0.2.0/24, 198.51.100.0/24,
    203.0.113.0/24, 2001:db8::/32). Les attributs utiles à la détection (pays, ASN,
    type d'accès, hébergeur) sont portés par le bloc "geo" du scénario.
  - IP Microsoft (AS8075) conservées : infrastructure publique, nécessaires pour
    tester l'exclusion Microsoft.
La table de correspondance réelle est tenue hors dépôt (PRIVATE_mapping.md).

Chaque événement porte :
  label       attacker | legit | system | unknown
  provenance  observed      valeur relevée pendant l'incident
              reconstructed fait établi, horodatage ou détail reconstitué
              synthetic     volume généré pour reproduire un fait chiffré (ex : 773 requêtes / 602 IP)

Usage : python3 build_m365_fixtures.py [--out fixtures/m365] [--seed 20260929]
Déterministe : même seed, même sortie.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

UTC = timezone.utc
PARIS_OFFSET = timedelta(hours=2)  # CEST sur toute la période couverte

APP = {
    "office": ("d3590ed6-52b3-4102-aeff-aad2292ab01c", "Microsoft Office"),
    "teams": ("1fec8e78-bce4-4aaf-ab1b-5451cc387264", "Microsoft Teams"),
    "broker": ("29d9ed98-a469-4536-ade2-f981bc1d605e", "Microsoft Authentication Broker"),
    "owa": ("9199bf20-a13f-4107-85dc-02114787ef48", "One Outlook Web"),
    "outlook_mobile": ("27922004-5251-4030-b22d-91ecd9a37ea4", "Outlook Mobile"),
    "outlook_mac": ("d3590ed6-52b3-4102-aeff-aad2292ab01c", "Microsoft Office"),
    "partner_center": ("4990cffe-04e8-4e8b-808a-1175604b879f", "Partner Center"),
    "portal": ("c44b4083-3bb0-49c1-b47d-974e53cbdf3c", "Azure Portal"),
    "phish_redirect": ("00000000-0000-4000-b000-000000000001", "Application tierce (redirection du lien)"),
}
RES_GRAPH = "Microsoft Graph"
RES_EXO = "Office 365 Exchange Online"
RES_DRS = "Device Registration Service"

UA_WIN_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
UA_MAC_OUTLOOK = "MacOutlook/16.112.26082125 (ARM64 Mac OS X 26.6.2 (Build 25G83))"
UA_IOS_OUTLOOK = "Outlook-iOS/2.0"
UA_WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"
UA_ANDROID = "Mozilla/5.0 (Linux; Android 16; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
UA_PY_REQUESTS = "python-requests/2.34.2"
UA_PY_URLLIB = "Python-urllib/3.12"


def paris(s: str) -> datetime:
    """'2026-09-21 12:26:00' heure de Paris -> datetime UTC."""
    return (datetime.fromisoformat(s) - PARIS_OFFSET).replace(tzinfo=UTC)


def iso(d: datetime) -> str:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Scenario:
    def __init__(self, sid: str, seed: int):
        self.sid = sid
        self.rnd = random.Random(f"{sid}:{seed}")
        self.events: list[dict] = []
        self.geo: dict[str, dict] = {}
        self.n = 0

    def uid(self, tag: str) -> str:
        return str(uuid.UUID(int=self.rnd.getrandbits(128), version=4)) if tag == "" else str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.sid}/{tag}"))

    def add_geo(self, ip: str, **kw):
        self.geo[ip] = kw

    def ev(self, source: str, ts: datetime, label: str, provenance: str, **kw) -> dict:
        self.n += 1
        e = {"id": f"{self.sid}-{self.n:06d}", "ts": iso(ts), "source": source, "label": label, "provenance": provenance}
        e.update({k: v for k, v in kw.items() if v is not None})
        self.events.append(e)
        return e

    def signin(self, ts, label, prov, user, ip, *, app="office", resource=RES_EXO, interactive=True, error=0,
               ua=UA_WIN_CHROME, client_app="Browser", auth_req="singleFactorAuthentication", mfa=None,
               protocol="none", transfer=None, session=None, device_id=None, device_name=None, os_=None,
               browser=None, failure=None, cross_tenant=None, home_tenant=None, note=None):
        app_id, app_name = APP[app]
        return self.ev("signin", ts, label, prov, user=user, ip=ip, interactive=interactive, appId=app_id,
                       appName=app_name, resource=resource, clientApp=client_app, userAgent=ua, errorCode=error,
                       failureReason=failure, authRequirement=auth_req, mfaMethod=mfa, authProtocol=protocol,
                       originalTransferMethod=transfer, sessionId=session, deviceId=device_id,
                       deviceName=device_name, os=os_, browser=browser, caStatus="notApplied",
                       crossTenantAccessType=cross_tenant, homeTenant=home_tenant, note=note)

    def ual(self, ts, label, prov, user, ip, operation, *, workload="Exchange", result="Succeeded", client_info=None,
            app_id=None, session=None, access=None, folder=None, subject=None, items=None, params=None, note=None):
        return self.ev("ual", ts, label, prov, user=user, ip=ip, operation=operation, workload=workload,
                       resultStatus=result, clientInfo=client_info, appId=app_id, sessionId=session,
                       mailAccessType=access, folder=folder, itemSubject=subject, itemCount=items,
                       params=params, note=note)

    def audit(self, ts, label, prov, activity, *, category, result="success", initiated_by, ip=None, target,
              target_type="User", modified=None, note=None):
        return self.ev("entra_audit", ts, label, prov, activity=activity, category=category, result=result,
                       initiatedBy=initiated_by, ip=ip, target=target, targetType=target_type,
                       modifiedProperties=modified, note=note)

    def trace(self, ts, label, prov, sender, recipient, subject, status, from_ip, direction, message_id,
              verdict=None, note=None):
        return self.ev("message_trace", ts, label, prov, sender=sender, recipient=recipient, subject=subject,
                       status=status, fromIp=from_ip, direction=direction, messageId=message_id,
                       filterVerdict=verdict, note=note)

    def sorted_events(self):
        return sorted(self.events, key=lambda e: (e["ts"], e["id"]))


def doc_pool(networks: list[str]) -> list[str]:
    out = []
    for n in networks:
        out += [str(h) for h in ipaddress.ip_network(n).hosts()]
    return out


# ════════════════════════════════════════════════════════════════════════════
# Scénario A : AiTM, jonction de postes, accès python-requests, phishing interne
# ════════════════════════════════════════════════════════════════════════════
def scenario_a(seed: int) -> dict:
    s = Scenario("incident-a-aitm", seed)
    D = "tenant-a.example"
    V = f"compta1@{D}"          # victime
    CEO = f"ceo@{D}"
    FWD = f"employee-fwd@{D}"   # collaborateur qui transfère le leurre à la direction
    ADM = f"globaladmin@tenant-a.onmicrosoft.example"
    COPIER = f"copier@{D}"
    DELEG = f"assistant@{D}"
    PARTNER = "user_0001@partner-csp.example"

    # ── IP et géo
    HQ = "2001:db8:100::160"
    HOME_V = "2001:db8:388f:c340::10"
    RELAY1, RELAY2 = "2001:db8:a::35", "2001:db8:a::112"
    ATK_FIRST = "2001:db8:b::172"
    ATK_JOIN = "2001:db8:b::243"
    ATK_OWA = "2001:db8:b::200"
    CEO_HAWAII, CEO_CA, CEO_NY = "2001:db8:c::74", "2001:db8:c::24", "2001:db8:c::215"
    CEO_STARLINK = "2001:db8:5a7:310::185"
    CEO_ROAM = "2001:db8:d::92"
    MSP_HOTLINE, MSP_ENGINEER = "2001:db8:e::59", "2001:db8:e::133"
    PARTNER_IP = "2001:db8:f::230"
    EXO_SRV1, EXO_SRV2 = "2603:10a6:800:154::14", "2603:10a6:803:d5::29"

    s.add_geo(HQ, country="FR", city="Paris", asn="AS12876", org="Siège du client", type="office")
    s.add_geo(HOME_V, country="FR", city="Rennes", asn="AS5410", org="Bouygues Telecom", type="residential")
    s.add_geo(RELAY1, country="FR", city=None, asn="AS15557", org="SFR", type="residential", note="relais AiTM (IP résidentielle)")
    s.add_geo(RELAY2, country="FR", city=None, asn="AS15557", org="SFR", type="residential", note="relais AiTM (IP résidentielle)")
    s.add_geo(ATK_FIRST, country="US", city=None, asn="AS-HOSTING-US", org="Hébergeur US", type="hosting")
    s.add_geo(ATK_JOIN, country="SG", city="Singapore", asn="AS-HOSTING-SG", org="Hébergeur SG", type="hosting")
    s.add_geo(ATK_OWA, country="US", city=None, asn="AS-HOSTING-US2", org="Hébergeur US", type="hosting")
    s.add_geo(CEO_HAWAII, country="US", city="Honolulu", asn="AS-HOTEL-US", org="Wi-Fi hôtel", type="residential")
    s.add_geo(CEO_CA, country="US", city="Los Angeles", asn="AS20001", org="Charter", type="residential")
    s.add_geo(CEO_NY, country="US", city="New York", asn="AS12271", org="Charter", type="residential")
    s.add_geo(CEO_STARLINK, country="US", city="Los Angeles", asn="AS14593", org="SpaceX Starlink", type="satellite")
    s.add_geo(CEO_ROAM, country="FR", city="Paris", asn="AS3215", org="Orange (itinérance 4G)", type="mobile")
    s.add_geo(MSP_HOTLINE, country="FR", city="Paris", asn="AS12876", org="MSP (hotline)", type="office")
    s.add_geo(MSP_ENGINEER, country="FR", city=None, asn="AS12322", org="MSP (ingénieur)", type="residential")
    s.add_geo(PARTNER_IP, country="MU", city="Port Louis", asn="AS23889", org="Partenaire CSP", type="office")
    for ip in (EXO_SRV1, EXO_SRV2):
        s.add_geo(ip, country="IE", city="Dublin", asn="AS8075", org="Microsoft", type="microsoft")
    s.add_geo("255.255.255.255", country=None, city=None, asn=None, org="NDR interne Exchange", type="microsoft")

    proxies = doc_pool(["198.51.100.0/24", "192.0.2.0/24", "203.0.113.0/25"])[:602]
    isp = [("AS3215", "Orange"), ("AS12322", "Free"), ("AS5410", "Bouygues Telecom"), ("AS15557", "SFR")]
    for ip in proxies:
        a, o = s.rnd.choice(isp)
        s.add_geo(ip, country="FR", city=None, asn=a, org=o, type="residential", note="proxy résidentiel de l'attaquant")
    us_retry = [f"2001:db8:9::{i:x}" for i in range(1, 21)]
    for ip in us_retry:
        s.add_geo(ip, country="US", city=None, asn="AS-US-MIXED", org="US (type inconnu)", type="unknown")

    dev = {
        "W1": ("00000000-0000-4000-a000-000000000001", "WKSTN-01"),
        "W2": ("00000000-0000-4000-a000-000000000002", "WKSTN-02"),
        "W3": ("00000000-0000-4000-a000-000000000003", "WKSTN-03"),
        "W4": ("00000000-0000-4000-a000-000000000004", "WKSTN-04"),
    }
    CEO_TABLET = ("00000000-0000-4000-a000-000000000010", "TABLET-PC")

    # ── Référence légitime de la victime (reconstruite à partir des constats)
    d = paris("2026-09-07 09:02:00")
    while d < paris("2026-09-21 12:00:00"):
        if d.weekday() < 5:
            for h in (9, 14):
                t = d.replace(hour=h - 2, minute=s.rnd.randint(0, 50))
                s.signin(t, "legit", "reconstructed", V, HQ, app="office", ua=UA_WIN_CHROME, auth_req="multiFactorAuthentication",
                         mfa="Microsoft Authenticator", os_="Windows", browser="Chrome")
            t = d.replace(hour=19, minute=s.rnd.randint(0, 59))
            s.signin(t, "legit", "reconstructed", V, HOME_V, app="outlook_mac", ua=UA_MAC_OUTLOOK, client_app="Mobile Apps and Desktop clients",
                     auth_req="multiFactorAuthentication", mfa="Microsoft Authenticator", os_="MacOs")
        d += timedelta(days=1)
    s.signin(paris("2026-09-11 20:14:00"), "legit", "observed", V, HOME_V, ua=UA_WIN_CHROME, os_="Windows", browser="Chrome",
             auth_req="multiFactorAuthentication", mfa="Microsoft Authenticator", note="poste Windows depuis sa box, légitime")

    # ── 21/09 : relais AiTM (MFA relayé) puis session attaquant et jonction de poste
    for ip, hhmm in ((RELAY1, "12:26"), (RELAY2, "12:30")):
        base = paris(f"2026-09-21 {hhmm}:00")
        s.signin(base - timedelta(seconds=40), "attacker", "observed", V, ip, error=50074, failure="Strong Authentication is required.",
                 os_="Windows", browser="Chrome")
        s.signin(base - timedelta(seconds=20), "attacker", "observed", V, ip, error=50074, failure="Strong Authentication is required.",
                 os_="Windows", browser="Chrome")
        s.signin(base, "attacker", "observed", V, ip, auth_req="multiFactorAuthentication", mfa="Microsoft Authenticator",
                 os_="Windows", browser="Chrome", session=s.uid("aitm-session"), note="relais AiTM : mot de passe et code MFA relayés")
    t = paris("2026-09-21 12:31:10")
    s.audit(t, "attacker", "observed", "Register device", category="Device", initiated_by=V, ip=ATK_FIRST, target=dev["W1"][1],
            target_type="Device", modified=[{"name": "TrustType", "new": "AzureAd"}, {"name": "DeviceId", "new": dev["W1"][0]}])
    s.audit(t + timedelta(seconds=2), "attacker", "observed", "Add device", category="Device", initiated_by="Device Registration Service",
            target=dev["W1"][1], target_type="Device")
    for i in range(6):
        s.signin(paris("2026-09-21 12:31:00") + timedelta(seconds=12 * i), "attacker", "observed", V, ATK_FIRST, app="broker",
                 resource=RES_DRS if i == 0 else RES_GRAPH, interactive=i == 0, auth_req="multiFactorAuthentication",
                 mfa="Previously satisfied", session=s.uid("aitm-session"), device_id=dev["W1"][0], device_name=dev["W1"][1],
                 os_="Windows", note="première session de l'attaquant")

    # ── 21/09 14:12 -> 28/09 09:06 : 773 accès python-requests sur 602 IP résidentielles FR
    start, end = paris("2026-09-21 14:12:00"), paris("2026-09-28 09:06:00")
    order = proxies[:]
    s.rnd.shuffle(order)
    ips = order + [s.rnd.choice(order) for _ in range(773 - 602)]
    stamps = sorted(start + timedelta(seconds=s.rnd.randint(0, int((end - start).total_seconds()))) for _ in range(773))
    stamps[0], stamps[-1] = start, end
    for t, ip in zip(stamps, ips):
        dv = dev["W1"] if t < paris("2026-09-28 06:50:00") else dev[s.rnd.choice(["W2", "W3", "W4"])]
        s.signin(t, "attacker", "synthetic", V, ip, app="broker", resource=RES_GRAPH, interactive=False, ua=UA_PY_REQUESTS,
                 client_app="Mobile Apps and Desktop clients", auth_req="multiFactorAuthentication", mfa="Previously satisfied",
                 device_id=dv[0], device_name=dv[1], os_="Windows", session=s.uid("aitm-session"),
                 note="accès automatisé : 773 requêtes / 602 IP (chiffres observés, répartition synthétique)")

    # ── Direction en voyage (légitime)
    for hhmm, ip in (("2026-09-22 06:14:00", CEO_HAWAII), ("2026-09-26 16:45:00", CEO_CA), ("2026-09-28 05:08:00", CEO_NY),
                     ("2026-09-28 13:39:00", CEO_NY)):
        s.signin(paris(hhmm), "legit", "observed", CEO, ip, ua=UA_WIN_EDGE, os_="Windows", browser="Edge",
                 device_id=CEO_TABLET[0], device_name=CEO_TABLET[1], auth_req="multiFactorAuthentication",
                 mfa="Microsoft Authenticator", note="dirigeant en tour du monde, tablette enregistrée en 2022")
    d = paris("2026-09-24 08:00:00")
    while d < paris("2026-09-27 22:00:00"):
        s.signin(d, "legit", "observed", CEO, CEO_STARLINK, app="outlook_mobile", ua=UA_ANDROID, client_app="Mobile Apps and Desktop clients",
                 interactive=False, os_="Android", auth_req="multiFactorAuthentication", mfa="Previously satisfied", note="Starlink en voyage")
        d += timedelta(hours=7)
    s.signin(paris("2026-09-25 10:00:00"), "legit", "observed", CEO, CEO_ROAM, app="outlook_mobile", ua=UA_ANDROID,
             client_app="Mobile Apps and Desktop clients", interactive=False, os_="Android", note="4G Orange en itinérance")

    # ── Partenaire CSP (Partner Center) la nuit depuis Maurice : légitime
    for i in range(21):
        s.signin(paris("2026-09-27 04:16:00") + timedelta(minutes=3 * i + s.rnd.randint(0, 2)), "legit", "observed", PARTNER, PARTNER_IP,
                 app="partner_center", resource="Partner Center", cross_tenant="serviceProvider", home_tenant="partner-csp.example",
                 auth_req="multiFactorAuthentication", mfa="Previously satisfied", note="fournisseur de licences (CSP)")

    # ── 28/09 : jonction de 3 postes depuis Singapour, session OWA et envoi du leurre
    for k, sec in (("W2", 5), ("W3", 31), ("W4", 52)):
        t = paris("2026-09-28 06:50:00") + timedelta(seconds=sec)
        s.audit(t, "attacker", "observed", "Register device", category="Device", initiated_by=V, ip=ATK_JOIN, target=dev[k][1],
                target_type="Device", modified=[{"name": "TrustType", "new": "AzureAd"}, {"name": "DeviceId", "new": dev[k][0]}])
        s.signin(t - timedelta(seconds=3), "attacker", "observed", V, ATK_JOIN, app="broker", resource=RES_DRS, auth_req="multiFactorAuthentication",
                 mfa="Previously satisfied", device_id=dev[k][0], device_name=dev[k][1], os_="Windows")
    owa_session = s.uid("owa-session")
    s.signin(paris("2026-09-28 06:52:00"), "attacker", "observed", V, ATK_OWA, app="owa", interactive=False, auth_req="multiFactorAuthentication",
             mfa="Previously satisfied", session=owa_session, os_="Windows", browser="Chrome",
             note="session webmail 06:52 -> 11:09 ; aucune trace dans l'UAL (constat)")
    s.signin(paris("2026-09-28 11:09:00"), "attacker", "observed", V, ATK_OWA, app="owa", interactive=False, auth_req="multiFactorAuthentication",
             mfa="Previously satisfied", session=owa_session, os_="Windows", browser="Chrome")

    internal = [f"user{i:02d}@{D}" for i in range(1, 29)] + [CEO, FWD]  # 30 internes
    external = [f"contact{i:03d}@ext{(i % 60) + 1:02d}.example" for i in range(1, 112)]  # 111 externes
    rcpts = internal + external
    rcpts_157 = rcpts + s.rnd.sample(rcpts, 16)  # 157 envois pour 141 destinataires uniques
    send_t = paris("2026-09-28 08:49:00")
    for i, r in enumerate(rcpts_157):
        s.trace(send_t + timedelta(seconds=i // 20), "attacker", "observed" if i < 1 else "synthetic", V, r, "Urgent-Review Shared Document",
                "Delivered", ATK_OWA, "internal" if r.endswith(D) else "outbound", f"<phish-a-{i // 20}@{D}>",
                note="157 envois / 141 uniques / 30 internes / 111 externes (chiffres observés)")
    s.trace(paris("2026-09-28 08:49:09"), "legit", "observed", FWD, CEO, "TR : Urgent-Review Shared Document", "Delivered", EXO_SRV1,
            "internal", f"<fwd-a-1@{D}>", note="collaborateur qui signale le leurre à la direction")
    for i, (subj, hhmm) in enumerate((("RE: virement des sommes dues", "09:12"), ("RE: virement des sommes dues", "09:14"),
                                       ("TR: Devis_0000000001_20260926", "09:31"), ("TR: [Support MSP #0000001] Ticket resolved", "09:40"),
                                       ("TR: Devis_0000000001_20260926", "10:02"))):
        s.trace(paris(f"2026-09-28 {hhmm}:00"), "legit", "reconstructed", V, f"fournisseur{i}@ext90.example", subj, "Delivered", HQ,
                "outbound", f"<legit-a-{i}@{D}>", note="envoi légitime depuis le siège, dont un fil financier : ne pas classer en BEC")

    # ── Invalidation des jetons à 09:25 puis tentatives rejetées
    for i, ip in enumerate(us_retry):
        t = paris("2026-09-28 09:25:00") + timedelta(minutes=6 * i + s.rnd.randint(0, 4))
        s.signin(t, "attacker", "observed", V, ip, app="broker", resource=RES_GRAPH, interactive=False, ua=UA_PY_REQUESTS, error=50173,
                 failure="The provided grant has expired due to it being revoked.", client_app="Mobile Apps and Desktop clients",
                 note="tentatives après invalidation des jetons (09:25 -> 11:27)")

    # ── Intervention MSP (légitime)
    s.audit(paris("2026-09-28 12:40:00"), "legit", "reconstructed", "Reset password (by admin)", category="UserManagement", initiated_by=ADM,
            ip=MSP_ENGINEER, target=ADM)
    s.audit(paris("2026-09-28 13:10:00"), "legit", "reconstructed", "Disable account", category="UserManagement", initiated_by=ADM,
            ip=MSP_ENGINEER, target=V)
    s.audit(paris("2026-09-28 15:13:00"), "legit", "observed", "Delete device", category="Device", initiated_by=ADM, ip=MSP_ENGINEER,
            target="WKSTN-01", target_type="Device")
    s.audit(paris("2026-09-28 15:13:00"), "legit", "observed", "Update device registration policy", category="Policy", initiated_by=ADM,
            ip=MSP_ENGINEER, target="deviceRegistrationPolicy", target_type="Policy",
            modified=[{"name": "azureADJoin.allowedToJoin", "old": "all", "new": "none"}, {"name": "userDeviceQuota", "old": 50, "new": 20}])
    s.ual(paris("2026-09-28 15:28:00"), "legit", "observed", ADM, MSP_ENGINEER, "Remove-InboxRule", params="Identity=compta1\\10000000000000000001")

    # ── État de l'UAL (ingestion en retard sur les connexions)
    s.ual(paris("2026-09-22 17:40:00"), "legit", "observed", V, HOME_V, "UserLoggedIn", workload="AzureActiveDirectory",
          note="dernier UserLoggedIn ingéré dans l'UAL pour la victime (22/09) ; aucun logon ingéré sur le tenant les 3 derniers jours")

    posture = {
        "licence": "free",
        "securityDefaults": False,
        "conditionalAccessPolicies": [],
        "namedLocations": [],
        "authorizationPolicy": {"usersCanConsent": None, "note": "non collecté pendant l'incident"},
        "deviceRegistrationPolicy": {"joinAllowedTo": "all", "registerAllowedTo": "all", "userDeviceQuota": 50},
        "domains": [{"id": D, "authenticationType": "Managed", "isVerified": True},
                    {"id": "tenant-a.onmicrosoft.example", "authenticationType": "Managed", "isVerified": True}],
        "roleAssignments": [{"role": "Global Administrator", "principal": ADM, "principalType": "user"}],
        "users": [
            {"upn": V, "enabled": True, "mfaMethods": ["password", "microsoftAuthenticator"], "perUserMfa": "enforced",
             "lastPasswordChange": "2026-03-02T08:00:00Z", "provenance": "reconstructed"},
            {"upn": CEO, "enabled": True, "mfaMethods": ["password", "microsoftAuthenticator", "microsoftAuthenticator", "phone"],
             "perUserMfa": "enforced", "provenance": "observed"},
            {"upn": ADM, "enabled": True, "mfaMethods": ["password", "phone"], "perUserMfa": "enforced", "provenance": "observed"},
            {"upn": COPIER, "enabled": True, "mfaMethods": ["password"], "perUserMfa": "disabled", "provenance": "observed"},
            *[{"upn": f"{u}@{D}", "enabled": True, "mfaMethods": ["password"], "perUserMfa": "disabled", "provenance": "observed"}
              for u in ("shop1", "marketing", "production", "employee-fwd")],
        ],
        "entraDevices": [
            {"deviceId": CEO_TABLET[0], "displayName": CEO_TABLET[1], "owner": CEO, "trustType": "Workplace",
             "registrationDateTime": "2022-12-14T10:00:00Z", "label": "legit"},
            *[{"deviceId": v[0], "displayName": v[1], "owner": V, "trustType": "AzureAd",
               "registrationDateTime": iso(paris("2026-09-21 12:31:10") if k == "W1" else paris("2026-09-28 06:50:30")),
               "label": "attacker"} for k, v in dev.items()],
        ],
        "oauthGrants": [
            {"user": CEO, "app": "Gmail", "publisherVerified": False, "scope": "EAS.AccessAsUser.All", "label": "legit",
             "note": "compte Gmail de la direction branché sur la boîte, conservé"},
        ],
        "exchange": {
            "smtpClientAuthDisabledOrg": False,
            "casMailboxes": [{"mailbox": COPIER, "smtpClientAuthenticationDisabled": False, "label": "legit", "note": "copieur scan-to-mail"}],
            "unifiedAuditLogIngestionEnabledExoView": None,
            "mailboxForwarding": [],
            "inboxRules": [
                {"mailbox": V, "name": ".", "enabled": False, "priority": 1, "conditions": {}, "moveToFolder": "Archive", "markAsRead": True,
                 "deleteMessage": False, "forwardTo": [], "label": "attacker",
                 "note": "règle de masquage désactivée par le support mais jamais supprimée : doit être remontée même désactivée"},
                {"mailbox": V, "name": "Prestataire A", "enabled": True, "conditions": {"from": ["noreply@prestataire-a.example"]}, "moveToFolder": "Prestataire A", "label": "legit"},
                {"mailbox": V, "name": "Organisme B", "enabled": True, "conditions": {"from": ["contact@organisme-b.example"]}, "moveToFolder": "Organisme B", "label": "legit"},
                {"mailbox": V, "name": "Support MSP", "enabled": True, "conditions": {"subjectContainsWords": ["Support MSP"]},
                 "moveToFolder": "Support", "label": "legit", "note": "mot-clé MSP dans le nom : au plus MEDIUM"},
                {"mailbox": V, "name": "Comptabilité", "enabled": True, "conditions": {"sentTo": [f"compta@{D}"]}, "forwardTo": [f"compta2@{D}"], "label": "legit"},
            ],
            "mailboxPermissions": [{"mailbox": CEO, "user": DELEG, "rights": ["FullAccess"]},
                                   {"mailbox": CEO, "user": DELEG, "rights": ["SendAs"]}],
            "blockedSenders": [],
            "transportRules": [{"name": "Disclaimer", "redirect": [], "bcc": [], "setScl": None, "label": "legit"},
                               {"name": "Tag externe", "redirect": [], "bcc": [], "setScl": None, "label": "legit"}],
            "connectors": [],
        },
    }

    expected = {
        "mustRaise": [
            {"ruleId": "P-ID-01", "target": "tenant", "minSeverity": "HIGH"},
            {"ruleId": "P-ID-03", "target": "tenant", "minSeverity": "MEDIUM"},
            {"ruleId": "P-ID-10", "target": "tenant", "minSeverity": "MEDIUM"},
            {"ruleId": "P-EXO-03", "target": "tenant", "minSeverity": "MEDIUM"},
            {"ruleId": "P-EXO-09", "target": V, "minSeverity": "HIGH", "evidenceContains": "Archive",
             "why": "règle « . » : nom non alphanumérique, sans condition, Archive + marqué lu, même désactivée"},
            {"ruleId": "D-SI-02", "target": V, "minSeverity": "CRITICAL", "window": [iso(paris("2026-09-21 12:25:00")), iso(paris("2026-09-21 12:40:00"))],
             "why": "échecs 50074 puis succès MFA depuis une IP résidentielle inconnue, suivis sous 5 min d'une session hébergeur et d'une jonction de poste"},
            {"ruleId": "D-ID-02", "target": V, "minSeverity": "HIGH", "count": 4, "why": "4 postes joints : 21/09 12:31, 28/09 06:50 (x3)"},
            {"ruleId": "D-SI-01", "target": V, "minSeverity": "CRITICAL", "evidenceContains": "python-requests"},
            {"ruleId": "D-SI-07", "target": V, "minSeverity": "MEDIUM", "why": "602 IP distinctes en 7 jours"},
            {"ruleId": "D-MAIL-01", "target": V, "minSeverity": "CRITICAL", "why": "111 destinataires externes en une minute"},
            {"ruleId": "D-MAIL-02", "target": V, "minSeverity": "HIGH", "evidenceContains": "Urgent-Review Shared Document"},
            {"ruleId": "F-DATA-01", "target": "tenant", "minSeverity": "INFO", "why": "UAL sans UserLoggedIn depuis le 22/09"},
        ],
        "mustNotRaise": [
            {"target": CEO, "maxSeverity": "HIGH", "ruleIds": ["*"], "why": "dirigeant en voyage : IP US, Starlink, itinérance. Jamais CRITICAL"},
            {"target": CEO, "ruleIds": ["D-SI-01", "D-SI-02", "D-ID-02"], "why": "aucun indicateur d'attaque sur la direction"},
            {"target": CEO_TABLET[1], "ruleIds": ["D-ID-02"], "why": "tablette du dirigeant enregistrée en 2022"},
            {"target": HQ, "maxSeverity": "INFO", "ruleIds": ["*"], "why": "IP du siège déclarée de confiance"},
            {"target": V, "ruleIds": ["D-MAIL-04"], "window": [iso(paris("2026-09-28 09:00:00")), iso(paris("2026-09-28 10:30:00"))],
             "why": "fils financiers légitimes envoyés depuis le siège"},
            {"target": PARTNER, "maxSeverity": "MEDIUM", "ruleIds": ["*"], "why": "connexions du partenaire CSP (cross-tenant serviceProvider)"},
            {"target": "Support MSP", "maxSeverity": "MEDIUM", "ruleIds": ["P-EXO-09"], "why": "mot-clé MSP seul"},
            {"target": EXO_SRV1, "ruleIds": ["*"], "why": "serveur Exchange Online (AS8075)"},
            {"target": "255.255.255.255", "ruleIds": ["*"], "why": "NDR internes"},
            {"target": "ban-engine", "ruleIds": ["AUTO-BAN"], "why": "aucune des 602 IP résidentielles ne doit produire de ban automatique"},
        ],
        "unlabeled": [],
    }

    timeline = [
        ("2026-09-21 12:26", "Relais AiTM : échecs puis succès MFA depuis deux IP résidentielles FR"),
        ("2026-09-21 12:31", "Jonction de WKSTN-01 et 6 connexions depuis un hébergeur US"),
        ("2026-09-21 14:12", "Début de l'accès automatisé python-requests (773 requêtes / 602 IP FR)"),
        ("2026-09-28 06:50", "Jonction de 3 postes depuis Singapour"),
        ("2026-09-28 06:52", "Session webmail depuis un hébergeur US"),
        ("2026-09-28 08:49", "Envoi du leurre à 141 destinataires (157 envois)"),
        ("2026-09-28 09:25", "Invalidation des jetons, tentatives rejetées jusqu'à 11:27"),
    ]
    return build_doc(s, "Compromission AiTM, jonction de postes Entra et phishing interne", D, posture, expected, timeline, {
        "licence": "free", "timezone": "Europe/Paris", "allowedCountries": ["FR"], "trustedIps": [HQ, MSP_HOTLINE, MSP_ENGINEER],
        "mspKeywords": ["msp"], "partnerTenants": ["partner-csp.example"],
        "allowlists": {"oauthApps": [], "forwarding": [], "vpnAsns": []},
        "victims": [V], "users": [V, CEO, FWD, ADM, COPIER, DELEG] + internal[:28],
    })


# ════════════════════════════════════════════════════════════════════════════
# Scénario B : device code phishing, script Python sur jeton, campagne sortante
# ════════════════════════════════════════════════════════════════════════════
def scenario_b(seed: int) -> dict:
    s = Scenario("incident-b-devicecode", seed)
    D = "tenant-b.example"
    V = f"victim@{D}"
    V_ALIAS = f"victim-alias@{D}"
    CEO = f"ceo@{D}"
    ADM = "globaladmin@tenant-b.onmicrosoft.example"
    INFL = f"influencer01@{D}"

    OFFICE = "2001:db8:200::245"
    V_HOME1, V_HOME2 = "2001:db8:5866:5870::a7", "2001:db8:88b:650::51"
    V_MOBILE = "2001:db8:215:207::94"
    V_CH1, V_CH2 = "2001:db8:ce1::199", "2001:db8:ce1::18"
    ATK = "2001:db8:bad:5367::"
    SSPR_IP = "2001:db8:9a::92"
    LURE_SMTP = "2001:db8:1a::119"
    BR_UNKNOWN = "2001:db8:b4::67"
    CEO_ORANGE, CEO_VULTR, CEO_SFR = "2001:db8:cb1e:106d::1", "2001:db8:7717::201", "2001:db8:176:138::87"
    MSP = "2603:1026:2400::9"
    MS_SEND = ["20.190.190.101", "20.190.190.103", "20.20.34.96", "20.20.41.33", "20.231.130.224"]
    EXO_REST = "2603:10a6:102:161::7"

    s.add_geo(OFFICE, country="FR", city="Paris", asn="AS-OFFICE", org="Bureau du client", type="office")
    s.add_geo(V_HOME1, country="FR", city=None, asn="AS5410", org="Bouygues Telecom", type="residential")
    s.add_geo(V_HOME2, country="FR", city=None, asn="AS12322", org="Free", type="residential")
    s.add_geo(V_MOBILE, country="FR", city=None, asn="AS5410", org="Bouygues Telecom mobile", type="mobile")
    s.add_geo(V_CH1, country="CH", city=None, asn="AS15547", org="FAI résidentiel CH", type="residential")
    s.add_geo(V_CH2, country="CH", city=None, asn="AS15547", org="FAI résidentiel CH", type="residential")
    s.add_geo(ATK, country="UA", city="Kyiv", asn="AS43180", org="Hébergeur UA", type="hosting")
    s.add_geo(SSPR_IP, country="US", city=None, asn="AS7922", org="Comcast", type="residential")
    s.add_geo(LURE_SMTP, country="US", city=None, asn="AS-SMTP-US", org="Infrastructure d'envoi du leurre", type="hosting")
    s.add_geo(BR_UNKNOWN, country="BR", city="Porto Alegre", asn="AS47583", org="Hostinger", type="hosting")
    s.add_geo(CEO_ORANGE, country="FR", city=None, asn="AS3215", org="Orange mobile", type="mobile")
    s.add_geo(CEO_VULTR, country="US", city=None, asn="AS20473", org="Vultr", type="hosting", proxy=True)
    s.add_geo(CEO_SFR, country="FR", city=None, asn="AS5410", org="Bouygues Telecom", type="residential")
    for ip in MS_SEND + [MSP, EXO_REST]:
        s.add_geo(ip, country="IE", city="Dublin", asn="AS8075", org="Microsoft", type="microsoft")

    # ── Référence légitime de la victime (juillet -> septembre)
    d = paris("2026-08-31 09:00:00")
    while d < paris("2026-09-28 09:00:00"):
        if d.weekday() < 5:
            s.signin(d.replace(hour=7, minute=s.rnd.randint(0, 40)), "legit", "reconstructed", V, OFFICE, app="outlook_mac", ua=UA_MAC_OUTLOOK,
                     client_app="Mobile Apps and Desktop clients", os_="MacOs")
            s.ual(d.replace(hour=8, minute=s.rnd.randint(0, 59)), "legit", "reconstructed", V, OFFICE, "Send", client_info="Client=OutlookService;" + UA_MAC_OUTLOOK)
            s.signin(d.replace(hour=18, minute=s.rnd.randint(0, 59)), "legit", "reconstructed", V, s.rnd.choice([V_HOME1, V_HOME2, V_MOBILE]),
                     app="outlook_mobile", ua=UA_IOS_OUTLOOK, client_app="Mobile Apps and Desktop clients", interactive=False, os_="iOS")
        d += timedelta(days=1)
    # vacances près de la frontière suisse : alternance FAI CH / Bouygues mobile (légitime)
    for hhmm, ip in (("2026-08-12 11:23:20", V_CH2), ("2026-08-12 12:34:07", V_MOBILE), ("2026-08-12 15:26:13", V_CH2),
                     ("2026-08-12 16:16:29", V_MOBILE), ("2026-08-13 11:01:45", V_CH1), ("2026-08-13 11:53:33", V_MOBILE),
                     ("2026-08-13 15:56:03", V_CH2)):
        s.ual(paris(hhmm), "legit", "observed", V, ip, "MailItemsAccessed", client_info="Client=OutlookService;" + UA_IOS_OUTLOOK,
              access="Bind", note="vacances en Suisse près de la frontière")
    # événement non tranché
    s.signin(paris("2026-07-29 09:38:16"), "unknown", "observed", V, BR_UNKNOWN, error=0, os_="Windows", browser="Chrome",
             note="succès depuis Hostinger BR entre deux connexions FR de la victime ; non retenu par le rapport final")

    # ── 23/09 : leurre reçu, classé indésirable
    s.trace(paris("2026-09-23 14:19:00"), "attacker", "observed", "sender@lure-sender.example", V, "RE: EPC Contract & Project Management",
            "Delivered", LURE_SMTP, "inbound", "<lure-b-1@lure-sender.example>", verdict="Junk",
            note="leurre le plus probable ; supprimé définitivement ensuite de la boîte")
    s.ual(paris("2026-09-23 14:19:30"), "attacker", "reconstructed", V, None, "Create", folder="Courrier indésirable",
          subject="RE: EPC Contract & Project Management", workload="Exchange")
    # partenaire probablement compromis : phishing haute confiance mis en quarantaine
    for i, day in enumerate(("23", "24", "26", "28")):
        s.trace(paris(f"2026-09-{day} 10:0{i}:00"), "unknown", "observed", f"sender{i + 1}@partner-01.example", f"staff{i + 1}@{D}",
                "Document partagé", "Quarantined", "2001:db8:2e::10", "inbound", f"<pn-{i}@partner-01.example>", verdict="HighConfPhish",
                note="4 expéditeurs du même partenaire en quarantaine phishing haute confiance")
    s.add_geo("2001:db8:2e::10", country="FR", city=None, asn="AS8075", org="Microsoft (tenant du partenaire)", type="microsoft")

    # ── 24/09 : SSPR lancée depuis les US, non aboutie
    s.audit(paris("2026-09-24 04:46:00"), "attacker", "observed", "Self-service password reset flow activity progress", category="UserManagement",
            result="failure", initiated_by=V, ip=SSPR_IP, target=V, note="origine non identifiée")

    # ── 28/09 : saisie du code d'appareil depuis le bureau (session du navigateur de la victime)
    session = s.uid("hijacked-session")
    s.signin(paris("2026-09-28 11:50:00"), "attacker", "reconstructed", V, OFFICE, app="office", resource=RES_EXO, ua=UA_MAC_OUTLOOK,
             client_app="Browser", protocol="deviceCode", transfer="deviceCodeFlow", session=session, os_="MacOs", browser="Safari",
             note="validation du code d'appareil par la victime, déjà connectée ; heure reconstituée (avant 11:52)")
    # 13 renouvellements de jeton, script Python, clients Office et Teams, même session
    start, end = paris("2026-09-28 12:13:00"), paris("2026-09-29 10:08:00")
    step = (end - start) / 12
    for i in range(13):
        app = "office" if i % 2 == 0 else "teams"
        s.signin(start + step * i, "attacker", "reconstructed", V, ATK, app=app, resource=RES_EXO if app == "office" else RES_GRAPH,
                 interactive=False, ua=UA_PY_URLLIB, client_app="Mobile Apps and Desktop clients", protocol="none",
                 transfer="deviceCodeFlow", session=session, note="renouvellement de jeton (13 observés, cadence reconstituée)")
    # activité boîte : lecture continue, collecte des contacts
    t = start
    while t < end:
        s.ual(t, "attacker", "synthetic", V, ATK, "MailItemsAccessed", client_info="Client=REST;" + UA_PY_URLLIB, app_id=APP["office"][0],
              session=session, access="Bind", items=s.rnd.randint(5, 60))
        t += timedelta(minutes=s.rnd.randint(8, 25))
    for fld in ("Contacts", "Calendrier", "Éléments envoyés", "Boîte de réception"):
        s.ual(start + timedelta(minutes=20), "attacker", "reconstructed", V, ATK, "MailItemsAccessed", client_info="Client=REST;" + UA_PY_URLLIB,
              app_id=APP["office"][0], session=session, access="Sync", folder=fld, note="collecte des 2 566 adresses")

    # ── 29/09 02:54 -> 03:04 : 9 messages par lots d'environ 300, bloqués à 02:58
    ext_domains = [("extco01.example", 63), ("extco02.example", 21), ("extco03.example", 16), ("extco04.example", 14), ("extco05.example", 12),
                   ("extco06.example", 10), ("extco07.example", 9)]
    delivered_domains = []
    for dom, n in ext_domains:
        delivered_domains += [dom] * n
    others = [f"brand{i:03d}.example" for i in range(1, 158)]  # 157 autres sociétés -> 164 au total
    while len(delivered_domains) < 473:
        delivered_domains.append(others[(len(delivered_domains) - 145) % len(others)])
    all_rcpts = [f"r{i:04d}@{delivered_domains[i]}" if i < 473 else f"r{i:04d}@{s.rnd.choice(others + [d for d, _ in ext_domains])}"
                 for i in range(2566)]
    sizes = [237, 236] + [299] * 6 + [2566 - 473 - 299 * 6]
    idx = 0
    t0 = paris("2026-09-29 02:54:00")
    for m, size in enumerate(sizes):
        t = t0 + timedelta(seconds=int(m * (600 / 8)))
        mid = f"<vsa-b-{m + 1}@{D}>"
        s.ual(t, "attacker", "reconstructed", V, ATK, "Send", client_info="Client=REST;" + UA_PY_URLLIB, app_id=APP["office"][0],
              session=session, subject="Vendor Service Agreement - Review & Sign", params=f"RecipientCount={size}")
        ip = MS_SEND[m % len(MS_SEND)]
        for r in all_rcpts[idx: idx + size]:
            s.trace(t, "attacker", "synthetic" if m else "observed", V, r, "Vendor Service Agreement - Review & Sign",
                    "Delivered" if m < 2 else "Failed", ip, "outbound", mid,
                    note="2 566 destinataires, 473 remis dans 164 sociétés (observé) ; répartition par message reconstituée")
        idx += size
    # masquage : NDR, réponses et copies déplacés vers « Historique des conversations » sans règle
    for i in range(24):
        s.ual(paris("2026-09-29 03:05:00") + timedelta(minutes=i * 7), "attacker", "reconstructed", V, ATK, "MoveToFolder",
              client_info="Client=REST;" + UA_PY_URLLIB, session=session, folder="Historique des conversations",
              subject=("Undeliverable: Vendor Service Agreement - Review & Sign" if i % 3 else "RE: Vendor Service Agreement - Review & Sign"),
              items=1, note="masquage sans règle de boîte")
    s.ev("restricted_entity", paris("2026-09-29 03:00:00"), "system", "observed", user=V, action="BlockOutbound",
         note="Microsoft bloque l'envoi à 02:58 puis restreint le compte")

    # ── Réponse MSP (légitime)
    s.audit(paris("2026-09-29 10:14:08"), "legit", "observed", "Reset user password", category="UserManagement", initiated_by=ADM,
            ip=MSP, target=V)
    s.audit(paris("2026-09-29 10:44:00"), "legit", "observed", "Disable account", category="UserManagement", initiated_by=ADM, ip=MSP, target=V)
    s.audit(paris("2026-09-29 10:44:05"), "legit", "observed", "Revoke user sessions", category="UserManagement", initiated_by=ADM, ip=MSP, target=V)
    s.audit(paris("2026-09-29 10:45:00"), "legit", "observed", "Remove delegated permission grant", category="ApplicationManagement",
            initiated_by=ADM, ip=MSP, target="eM Client", target_type="ServicePrincipal")

    # ── Direction : VPN mobile (légitime)
    s.ual(paris("2026-09-25 11:14:47"), "legit", "observed", CEO, CEO_ORANGE, "MailItemsAccessed", client_info="Client=OutlookService;" + UA_IOS_OUTLOOK,
          app_id=APP["outlook_mobile"][0], access="Bind")
    s.ual(paris("2026-09-25 12:49:56"), "legit", "observed", CEO, EXO_REST, "MailItemsAccessed", client_info="Client=REST;Client=RESTSystem;;", access="Bind")
    ceo_vpn_session = s.uid("ceo-vpn")
    s.ual(paris("2026-09-25 13:41:58"), "legit", "observed", CEO, CEO_VULTR, "MailItemsAccessed", client_info="Client=OutlookService;" + UA_IOS_OUTLOOK,
          app_id=APP["outlook_mobile"][0], session=ceo_vpn_session, access="Bind", note="VPN sur iPhone probable")
    s.ual(paris("2026-09-25 13:42:00"), "legit", "observed", CEO, CEO_VULTR, "Create", client_info="Client=OutlookService;" + UA_IOS_OUTLOOK,
          app_id=APP["outlook_mobile"][0], session=ceo_vpn_session, folder="\\Brouillons", subject="Fw: Document personnel",
          note="brouillon personnel")
    s.ual(paris("2026-09-25 14:08:15"), "legit", "observed", CEO, CEO_VULTR, "MailItemsAccessed", client_info="Client=OutlookService;" + UA_IOS_OUTLOOK,
          app_id=APP["outlook_mobile"][0], session=ceo_vpn_session, access="Bind")
    s.ual(paris("2026-09-25 15:34:44"), "legit", "observed", CEO, CEO_SFR, "Create", client_info="Client=OutlookService;" + UA_MAC_OUTLOOK)
    s.ual(paris("2026-09-25 15:35:29"), "legit", "observed", CEO, CEO_SFR, "Send", client_info="Client=OutlookService;" + UA_MAC_OUTLOOK)

    # ── État de l'UAL
    s.ual(paris("2026-09-25 14:15:37"), "legit", "observed", V, OFFICE, "UserLoggedIn", workload="AzureActiveDirectory",
          note="dernier UserLoggedIn ingéré pour la victime ; UAL vide après le 27/09 au soir au moment de l'enquête")

    ok_apps = ["Apple Internet Accounts", "Sellsy CRM", "Sellsy Email", "Apollo", "Modash.io", "ContactOut", "RocketReach"]
    posture = {
        "licence": "free",
        "securityDefaults": False,
        "conditionalAccessPolicies": [],
        "namedLocations": [],
        "authorizationPolicy": {"usersCanConsent": True, "permissionGrantPoliciesAssigned": ["ManagePermissionGrantsForSelf.microsoft-user-default-legacy"]},
        "deviceRegistrationPolicy": {"joinAllowedTo": "all", "registerAllowedTo": "all", "userDeviceQuota": 50},
        "deviceCodeFlowBlocked": False,
        "domains": [{"id": D, "authenticationType": "Managed", "isVerified": True},
                    {"id": "tenant-b.onmicrosoft.example", "authenticationType": "Managed", "isVerified": True}],
        "technicalNotificationMails": ["support@msp.example"],
        "roleAssignments": [
            {"role": "Global Administrator", "principal": ADM, "principalType": "user"},
            {"role": "Exchange Administrator", "principal": "AdminDroid Service Application", "principalType": "servicePrincipal"},
        ],
        "appPermissions": [
            {"client": "AdminDroid Service Application", "microsoft": False, "resource": "Microsoft Graph", "permission": p}
            for p in ("User.ReadWrite.All", "Directory.ReadWrite.All")
        ] + [{"client": "AdminDroid Service Application", "microsoft": False, "resource": "Office 365 Exchange Online",
              "permission": "Exchange.ManageAsApp"}],
        "users": [
            {"upn": V, "enabled": True, "mfaMethods": ["password"], "lastPasswordChange": "2026-09-29T08:14:08Z", "provenance": "observed"},
            {"upn": CEO, "enabled": True, "mfaMethods": ["password"], "lastPasswordChange": "2025-06-23T11:24:17Z", "provenance": "observed"},
            *[{"upn": f"{u}@{D}", "enabled": True, "createdDateTime": "2026-09-10T09:00:00Z", "mfaMethods": ["password"],
               "provenance": "observed", "note": "compte créé dans les 30 jours"} for u in ("new01", "new02", "new03", "new04")],
        ],
        "entraDevices": [],
        "oauthGrants": [
            {"user": V, "app": "eM Client", "publisherVerified": True, "scope": "IMAP.AccessAsUser.All", "label": "legit",
             "note": "hors de cause selon le rapport, retiré par précaution ; reste une app de la liste BEC"},
            {"user": V, "app": "RocketReach", "publisherVerified": True,
             "scope": "openid offline_access profile email User.Read People.Read Calendars.ReadWrite Mail.ReadWrite Mail.Send MailboxSettings.Read Contacts.ReadWrite",
             "label": "legit", "note": "outil de prospection, hors de cause"},
            {"user": V, "app": "Apple Internet Accounts", "publisherVerified": True, "scope": "offline_access openid EWS.AccessAsUser.All", "label": "legit"},
            {"user": f"sales01@{D}", "app": "test", "publisherVerified": False, "scope": "User.Read Mail.Read Mail.ReadWrite Mail.Send People.Read offline_access",
             "label": "unknown", "note": "origine à identifier"},
            *[{"user": f"staff{i:02d}@{D}", "app": "Apple Internet Accounts", "publisherVerified": True,
               "scope": "offline_access openid EWS.AccessAsUser.All", "label": "legit"} for i in range(1, 14)],
            {"user": f"sales02@{D}", "app": "Apollo", "publisherVerified": True, "scope": "Mail.ReadWrite Mail.Send Contacts.ReadWrite", "label": "legit"},
        ],
        "exchange": {
            "smtpClientAuthDisabledOrg": True,
            "unifiedAuditLogIngestionEnabledExoView": False,
            "unifiedAuditLogHasRecentEvents": True,
            "applicationImpersonationAssignments": [{"assignee": "Organization Management", "delegationType": "DelegatingOrgWide"}],
            "mailboxForwarding": [
                {"mailbox": INFL, "forwardingSmtpAddress": "influencer01@gmail.example", "deliverToMailboxAndForward": True, "label": "legit",
                 "note": "influenceur géré : transfert vers sa boîte perso, allowlisté"},
                {"mailbox": f"staff05@{D}", "forwardingSmtpAddress": f"staff06@{D}", "deliverToMailboxAndForward": True, "label": "legit"},
            ],
            "inboxRules": [],
            "blockedSenders": [{"sender": V, "reason": "OutboundSpamLimitExceeded", "createdDatetime": iso(paris("2026-09-29 03:00:00"))}],
            "junkConfig": [{"mailbox": V, "blockedSendersAndDomains": []}],
            "transportRules": [],
            "connectors": [],
            "mobileDevices": [{"mailbox": V, "model": "Mac", "os": "macos", "clientType": "Outlook", "firstSync": "2025-10-27T15:32:39Z", "label": "legit"},
                              {"mailbox": V, "model": "Outlook for iOS and Android", "os": "iOS 27.0", "clientType": "Outlook",
                               "firstSync": "2026-01-10T09:52:37Z", "label": "legit"}],
        },
    }

    expected = {
        "mustRaise": [
            {"ruleId": "P-ID-01", "target": "tenant", "minSeverity": "HIGH"},
            {"ruleId": "P-ID-09", "target": "tenant", "minSeverity": "MEDIUM"},
            {"ruleId": "P-ID-17", "target": "tenant", "minSeverity": "HIGH", "why": "flux device code non bloqué"},
            {"ruleId": "P-ID-05", "target": "AdminDroid Service Application", "minSeverity": "HIGH"},
            {"ruleId": "P-APP-03", "target": "AdminDroid Service Application", "minSeverity": "HIGH"},
            {"ruleId": "P-APP-05", "target": V, "minSeverity": "HIGH", "evidenceContains": "eM Client"},
            {"ruleId": "P-EXO-12", "target": V, "minSeverity": "HIGH"},
            {"ruleId": "D-SI-09", "target": V, "minSeverity": "CRITICAL", "evidenceContains": "deviceCodeFlow"},
            {"ruleId": "D-SI-01", "target": V, "minSeverity": "CRITICAL", "evidenceContains": "Python-urllib"},
            {"ruleId": "D-SI-10", "target": V, "minSeverity": "CRITICAL", "why": "clients Office/Teams avec user agent de script"},
            {"ruleId": "D-SI-11", "target": V, "minSeverity": "CRITICAL", "why": "même session Entra au bureau puis depuis AS43180"},
            {"ruleId": "D-SI-03", "target": V, "minSeverity": "HIGH", "evidenceContains": "UA"},
            {"ruleId": "D-EXO-04", "target": V, "minSeverity": "CRITICAL", "why": "Sync de Contacts / Calendrier depuis un hébergeur étranger"},
            {"ruleId": "D-EXO-06", "target": V, "minSeverity": "HIGH", "evidenceContains": "Historique des conversations"},
            {"ruleId": "D-MAIL-01", "target": V, "minSeverity": "CRITICAL"},
            {"ruleId": "D-MAIL-05", "target": V, "minSeverity": "HIGH", "why": "environ 300 destinataires par message"},
            {"ruleId": "D-ID-06", "target": V, "minSeverity": "MEDIUM", "why": "SSPR lancée depuis les US le 24/09"},
            {"ruleId": "D-IN-01", "target": "partner-01.example", "minSeverity": "MEDIUM", "why": "partenaire en quarantaine phishing haute confiance"},
            {"ruleId": "F-DATA-01", "target": "tenant", "minSeverity": "INFO"},
        ],
        "mustNotRaise": [
            {"target": CEO, "maxSeverity": "MEDIUM", "ruleIds": ["*"], "window": [iso(paris("2026-09-25 13:00:00")), iso(paris("2026-09-25 15:00:00"))],
             "why": "VPN mobile : même client Outlook iOS, action personnelle, IP absente des autres comptes"},
            {"target": V, "maxSeverity": "MEDIUM", "ruleIds": ["D-SI-03", "D-SI-04"], "window": [iso(paris("2026-08-12 00:00:00")), iso(paris("2026-08-14 00:00:00"))],
             "why": "vacances dans un pays limitrophe, FAI résidentiel"},
            {"target": OFFICE, "maxSeverity": "INFO", "ruleIds": ["*"], "why": "IP du bureau déclarée de confiance"},
            {"target": "RocketReach", "maxSeverity": "INFO", "ruleIds": ["*"], "why": "app allowlistée, hors de cause"},
            {"target": "Apple Internet Accounts", "maxSeverity": "INFO", "ruleIds": ["*"], "why": "app allowlistée"},
            {"target": INFL, "maxSeverity": "INFO", "ruleIds": ["P-EXO-05"], "why": "transfert allowlisté (métier du client)"},
            {"target": "Organization Management", "ruleIds": ["P-APP-07"], "why": "assignation de délégation"},
            {"target": "tenant", "ruleIds": ["P-EXO-02"], "why": "valeur EXO fausse alors que l'UAL contient des événements"},
            {"target": MSP, "ruleIds": ["*"], "why": "actions de l'administrateur MSP"},
            {"target": "20.190.190.101", "ruleIds": ["D-SI-*"], "why": "IP Microsoft d'envoi API"},
            {"target": "ban-engine", "ruleIds": ["AUTO-BAN"], "why": "aucune IP Microsoft ni mobile bannie automatiquement"},
        ],
        "unlabeled": [
            {"target": BR_UNKNOWN, "ts": iso(paris("2026-07-29 09:38:16")),
             "why": "succès depuis Hostinger BR intercalé dans une session FR. Motif AiTM possible, non confirmé par l'enquête. "
                    "Une détection D-SI-02 est acceptable mais ne compte ni en succès ni en échec."},
        ],
    }
    timeline = [
        ("2026-09-23 14:19", "Leurre reçu, classé indésirable, supprimé ensuite"),
        ("2026-09-24 04:46", "SSPR lancée depuis les US, non aboutie"),
        ("2026-09-28 11:52", "Saisie du code d'appareil par la victime au bureau (au plus tard)"),
        ("2026-09-28 12:13", "Script Python depuis AS43180 (Kyiv), 13 renouvellements de jeton"),
        ("2026-09-29 02:54", "Envoi de 9 messages à 2 566 destinataires externes"),
        ("2026-09-29 02:58", "Blocage de l'envoi par Microsoft, 473 remis"),
        ("2026-09-29 10:08", "Dernière connexion de l'attaquant"),
        ("2026-09-29 10:44", "Blocage du compte et révocation des sessions"),
    ]
    return build_doc(s, "Device code phishing, script Python sur jeton et campagne sortante", D, posture, expected, timeline, {
        "licence": "free", "timezone": "Europe/Paris", "allowedCountries": ["FR"], "trustedIps": [OFFICE],
        "neighborCountriesTolerance": ["CH", "BE", "ES", "IT", "DE", "LU"], "mspKeywords": ["msp"], "partnerTenants": [],
        "allowlists": {"oauthApps": ok_apps, "forwarding": [{"mailbox": INFL, "to": "influencer01@gmail.example"}], "vpnAsns": []},
        "victims": [V], "users": [V, V_ALIAS, CEO, ADM, INFL],
    })


def build_doc(s: Scenario, title, domain, posture, expected, timeline, tenant_cfg) -> dict:
    ev = s.sorted_events()
    counts = {}
    for e in ev:
        k = f"{e['source']}/{e['label']}"
        counts[k] = counts.get(k, 0) + 1
    return {
        "$schema": "../scenario.schema.json",
        "id": s.sid,
        "version": 1,
        "title": title,
        "generatedBy": "tools/build_m365_fixtures.py",
        "tenant": {"domain": domain, **tenant_cfg},
        "geo": dict(sorted(s.geo.items())),
        "posture": posture,
        "events": ev,
        "expected": expected,
        "groundTruthTimeline": [{"paris": t, "utc": iso(paris(t + ":00")), "event": e} for t, e in timeline],
        "stats": {"events": len(ev), "bySourceAndLabel": dict(sorted(counts.items()))},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="fixtures/m365")
    ap.add_argument("--seed", type=int, default=20260929)
    a = ap.parse_args()
    out = Path(a.out)
    for doc in (scenario_a(a.seed), scenario_b(a.seed)):
        p = out / doc["id"] / "scenario.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(f"{p}  {doc['stats']['events']} événements")


if __name__ == "__main__":
    main()
