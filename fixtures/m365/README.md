# Scénarios de rejeu M365 Guard

Deux incidents réels de septembre 2026, pseudonymisés, servent de vérité terrain pour les règles de posture et de détection du module M365 Guard.

| Scénario | Technique | Événements |
|---|---|---|
| `incident-a-aitm` | Hameçonnage avec relais MFA (AiTM), jonction de 4 postes Entra, accès `python-requests` via 602 IP résidentielles, règle de masquage « . », leurre envoyé par webmail à 141 destinataires | 1 057 |
| `incident-b-devicecode` | Hameçonnage par code d'appareil, script `Python-urllib` sur jeton depuis un hébergeur (AS43180), clients Office et Teams empruntés, 2 566 destinataires externes, masquage sans règle | 2 786 |

## Structure d'un scénario

Format décrit par `scenario.schema.json`.

- `tenant` : configuration du tenant dans Obliguard (licence, pays autorisés, IP de confiance, allowlists, mots-clés du MSP, partenaires CSP).
- `geo` : attributs de chaque IP (pays, ASN, type `office`, `residential`, `mobile`, `hosting`, `satellite`, `microsoft`, `unknown`). Le harnais les injecte à la place de la géolocalisation réelle.
- `posture` : instantané de configuration (utilisateurs et MFA, rôles, appareils, consentements, permissions applicatives, Exchange).
- `events` : événements normalisés triés par `ts` (UTC). Sources :
  - `signin` ;
  - `ual` ;
  - `entra_audit` ;
  - `message_trace` (une ligne par destinataire) ;
  - `restricted_entity`.
- `expected` : `mustRaise`, `mustNotRaise`, `unlabeled`. Voir la section 8 du brief pour les règles d'évaluation.
- `groundTruthTimeline` : chronologie du rapport d'incident, en heure de Paris et en UTC.

## Provenance

Chaque événement indique d'où il vient :

| Valeur | Sens |
|---|---|
| `observed` | Valeur relevée pendant l'enquête (horodatage, IP, user agent, chiffre). |
| `reconstructed` | Fait établi par l'enquête, dont un détail est reconstitué (heure exacte, ordre, cadence). |
| `synthetic` | Volume généré pour reproduire un fait chiffré observé. Exemples : 773 requêtes réparties sur 602 IP, destinataires fictifs. |

Les totaux sont exacts. La répartition fine d'un volume `synthetic` ne doit servir à calibrer aucune règle.

## Pseudonymisation

Le dépôt est public, donc aucune donnée client réelle ne doit y figurer :
- domaines clients : `tenant-a.example`, `tenant-b.example` ;
- utilisateurs : rôles fonctionnels (`compta1`, `ceo`, `victim`…) ;
- sociétés tierces destinataires, partenaires et organismes : numérotés (`extco01.example`, `partner-01.example`, `Prestataire A`, `Organisme B`). Aucun pseudonyme ne reprend une racine du nom réel.
- noms d'hôte et identifiants d'appareil : `WKSTN-01` à `WKSTN-04`, `TABLET-PC`, GUID numérotés. Aucun fragment de l'identifiant réel n'est conservé.
- IP non Microsoft : plages de documentation (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`). La famille IPv4 / IPv6 n'est pas conservée. Les attributs utiles sont dans `geo`.
- IP Microsoft (AS8075) : conservées, pour tester leur exclusion.
- fournisseurs d'accès et hébergeurs dans `geo.org` : conservés quand ils désignent une infrastructure publique, génériques quand ils localiseraient une personne.
- objets de message : tous remplacés, y compris les leurres. Les objets de substitution gardent la famille du leurre d'origine (document partagé, demande de signature, relance de contrat), ce que testent D-MAIL-02 et D-EXO-06.
- empreintes logicielles et matérielles : numéros de build, versions détaillées et modèles d'appareil retirés des user agents. Les user agents d'automate (`python-requests`, `Python-urllib`) sont conservés : ce sont les indicateurs de D-SI-01.
- noms d'applications tierces (`eM Client`, `RocketReach`, `Apollo`, `AdminDroid`…) : conservés. Ils désignent des éditeurs, pas le client, et P-APP-05 comme D-ID-03 reposent dessus.

La correspondance avec les valeurs réelles reste hors dépôt.

## Contrôler avant de committer

```bash
node tools/check_m365_fixtures.mjs --map ~/obliguard-private/mapping_fixtures_M365.md
```

Le contrôle vérifie la conformité au schéma, les invariants de rejeu (tri par `ts`, identifiants uniques, chaque IP d'événement présente dans `geo`, plages de documentation) et, avec `--map`, qu'aucune valeur de la table de correspondance n'apparaît dans les scénarios. Sans `--map`, le contrôle de fuite n'est pas exécuté et le script le signale.

## Régénérer

```bash
python3 tools/build_m365_fixtures.py --out fixtures/m365
```

La sortie est déterministe (seed fixe) et écrite en LF : un diff non vide signale un changement du générateur.

## Ajouter un incident à partir d'exports réels

```bash
python3 tools/import_real_exports.py \
  --key-file ~/.obliguard_fixture_key --tenant-domain client-reel.fr --pseudo-domain tenant-c.example \
  --roles roles.json --labels labels.json --keep-subject "objet du leurre" \
  --out events_observed.json --private-map ~/obliguard_private_map.json \
  InteractiveSignIns.csv NonInteractiveSignIns.csv trace_detail.csv 111_target_ual_all.csv 140_target_ips.csv
```

Ensuite, fusionner `events` et `geo` dans un nouveau `scenario.json`, puis rédiger `expected` à partir du rapport d'incident. Le script s'arrête avec le code 2 si le domaine réel apparaît encore dans la sortie. `--private-map` doit rester hors du dépôt.
