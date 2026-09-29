#!/usr/bin/env node
// Contrôle des scénarios de rejeu M365 avant commit.
//
//   node tools/check_m365_fixtures.mjs
//   node tools/check_m365_fixtures.mjs --map ~/obliguard-private/mapping_fixtures_M365.md
//
// Sans --map : conformité au schéma, invariants de rejeu, plages d'IP.
// Avec --map : vérifie en plus qu'aucune valeur réelle de la table de
// correspondance n'apparaît dans les scénarios. Le dépôt est public, la table
// reste hors dépôt : ce contrôle est le dernier filet avant publication.
//
// Sortie 0 si tout passe, 1 sinon. Aucune dépendance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'fixtures', 'm365');

const ENUM = {
  licence: ['free', 'p1', 'p2'],
  geoType: ['office', 'residential', 'mobile', 'hosting', 'satellite', 'microsoft', 'unknown'],
  source: ['signin', 'ual', 'entra_audit', 'message_trace', 'restricted_entity'],
  label: ['attacker', 'legit', 'system', 'unknown'],
  provenance: ['observed', 'reconstructed', 'synthetic'],
  severity: ['INFO', 'MEDIUM', 'HIGH', 'CRITICAL'],
};

// Plages de documentation (RFC 5737 et RFC 3849) autorisées pour les IP pseudonymisées.
const DOC_V4 = [/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];
const DOC_V6 = /^2001:0?db8:/i;
// Seules exceptions : l'infrastructure Microsoft, conservée pour tester son exclusion,
// et l'adresse de diffusion des NDR internes Exchange.
const ALLOWED_REAL = /^(20\.|4\.209\.|52\.|2603:|255\.255\.255\.255$)/i;

const problems = [];
const fail = (scope, msg) => problems.push(`${scope} : ${msg}`);

// ── Conformité au schéma et invariants ──────────────────────────────────────

function checkScenario(name, doc) {
  const S = name;
  for (const k of ['id', 'version', 'title', 'tenant', 'geo', 'posture', 'events', 'expected']) {
    if (!(k in doc)) fail(S, `champ obligatoire absent : ${k}`);
  }
  if (doc.id !== name) fail(S, `id "${doc.id}" différent du nom de dossier`);
  if (!ENUM.licence.includes(doc.tenant?.licence)) fail(S, `licence invalide : ${doc.tenant?.licence}`);
  if (!/\.example$/.test(doc.tenant?.domain ?? '')) fail(S, `domaine de tenant non pseudonymisé : ${doc.tenant?.domain}`);

  // geo
  for (const [ip, g] of Object.entries(doc.geo)) {
    if (!ENUM.geoType.includes(g.type)) fail(S, `geo[${ip}] : type invalide "${g.type}"`);
    const isDoc = DOC_V4.some((r) => r.test(ip)) || DOC_V6.test(ip);
    if (!isDoc && !ALLOWED_REAL.test(ip)) fail(S, `geo[${ip}] : IP hors plage de documentation et hors infrastructure Microsoft`);
  }

  // events
  const seen = new Set();
  let prev = '';
  for (const [i, e] of doc.events.entries()) {
    const at = `events[${i}]`;
    for (const k of ['id', 'ts', 'source', 'label', 'provenance']) {
      if (!(k in e)) fail(S, `${at} : champ obligatoire absent : ${k}`);
    }
    if (!ENUM.source.includes(e.source)) fail(S, `${at} : source invalide "${e.source}"`);
    if (!ENUM.label.includes(e.label)) fail(S, `${at} : label invalide "${e.label}"`);
    if (!ENUM.provenance.includes(e.provenance)) fail(S, `${at} : provenance invalide "${e.provenance}"`);
    if (!/Z$/.test(e.ts ?? '')) fail(S, `${at} : horodatage non UTC "${e.ts}"`);
    if (seen.has(e.id)) fail(S, `${at} : identifiant dupliqué "${e.id}"`);
    seen.add(e.id);
    if (e.ts < prev) fail(S, `${at} : événements non triés par ts (${prev} puis ${e.ts})`);
    prev = e.ts;
    for (const f of ['ip', 'fromIp']) {
      if (e[f] && !(e[f] in doc.geo)) fail(S, `${at} : ${f} "${e[f]}" absente du bloc geo`);
    }
  }

  // expected
  for (const [i, r] of (doc.expected?.mustRaise ?? []).entries()) {
    if (!r.ruleId || !r.target) fail(S, `mustRaise[${i}] : ruleId et target obligatoires`);
    if (!ENUM.severity.includes(r.minSeverity)) fail(S, `mustRaise[${i}] : minSeverity invalide "${r.minSeverity}"`);
  }
  for (const [i, r] of (doc.expected?.mustNotRaise ?? []).entries()) {
    if (!r.target || !Array.isArray(r.ruleIds)) fail(S, `mustNotRaise[${i}] : target et ruleIds obligatoires`);
    if (r.maxSeverity && !ENUM.severity.includes(r.maxSeverity)) fail(S, `mustNotRaise[${i}] : maxSeverity invalide "${r.maxSeverity}"`);
  }
}

// ── Contrôle de fuite contre la table de correspondance privée ──────────────

// Extrait de la colonne « réel » les jetons qui identifient quelque chose :
// IP, domaines, parties locales d'adresse, fragments de GUID, longs nombres,
// noms d'hôte, noms d'éditeurs. La prose de la table ne produit pas de jeton.
//
// Tout jeton est cherché, y compris les courts. Un jeton court produit beaucoup
// de correspondances fortuites ("lou" dans "louer") : il est donc cherché en
// limite de mot, et sur les fragments numériques en limite d'octet, pour qu'un
// fragment réel ne puisse pas passer au travers.
function realTokens(markdown) {
  const tokens = new Set();
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;                       // pas une ligne de tableau
    const real = cells[2];
    if (!real || /^-+$/.test(real) || /^réel$/i.test(real)) continue;
    const add = (t) => t && tokens.add(t);

    for (const m of real.matchAll(/\b\d{1,3}(?:\.\d{1,3}){2,3}\b/g)) add(m[0]);
    for (const m of real.matchAll(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,}/gi)) add(m[0].replace(/:+$/, ''));
    for (const m of real.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]{2,})+\b/gi)) add(m[0]);
    for (const m of real.matchAll(/\b([a-z][a-z0-9._-]*)@/gi)) add(m[1]);
    for (const m of real.matchAll(/\b[0-9a-f]{8}(?:-[0-9a-f]{4})?\b/gi)) add(m[0]);
    for (const m of real.matchAll(/\b\d{12,}\b/g)) add(m[0]);
    for (const m of real.matchAll(/\b[A-Z][A-Z0-9]{2,}-[A-Z0-9]{4,}\b/g)) add(m[0]);

    // Cellule sans prose (ni parenthèse, ni virgule, ni point-virgule) : c'est une
    // valeur littérale, par exemple un nom d'éditeur. Elle est prise telle quelle,
    // ce qu'aucun motif ne saurait deviner. Les cellules avec prose restent
    // couvertes par les extracteurs ci-dessus.
    if (real.length <= 40 && !/[(),;]/.test(real)) add(real);
  }
  return [...tokens];
}

// Un jeton purement numéro-pointé ("0.87") ne doit matcher qu'en frontière
// d'octet, sinon "20.87" ou "10.870" déclencheraient à tort. Les autres jetons
// courts sont cherchés en limite de mot. Les jetons longs restent en sous-chaîne :
// un fragment réel noyé dans une chaîne plus grande doit être vu.
function occurrence(text, token) {
  if (token.length >= 8) {
    const i = text.toLowerCase().indexOf(token.toLowerCase());
    return i === -1 ? null : i;
  }
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /^[\d.]+$/.test(token)
    ? `(?<![\\d.])${esc}(?![\\d.])`
    : `(?<![a-z0-9])${esc}(?![a-z0-9])`;
  const m = text.match(new RegExp(pattern, 'i'));
  return m ? m.index : null;
}

// Aucun jeton n'est exempté de la recherche, et aucune correspondance n'est
// masquée. Un pseudonyme qui entre en collision avec un jeton réel se renomme
// plutôt que se whiteliste : une liste d'exceptions finit par cacher une vraie fuite.
//
// Restent les jetons qui sont des mots courants, comme « admin » : ils
// apparaissent dans des constantes Microsoft (« Reset password (by admin) »)
// qu'on ne peut pas réécrire sans fausser les données. Ces correspondances sont
// affichées une par une avec leur contexte, pour être relues, et ne bloquent pas.
// Toute autre correspondance est une fuite et fait échouer le contrôle.
const COMMON_WORDS = new Set(['admin', 'test', 'support', 'contact', 'info', 'service']);

function checkLeaks(mapPath, files) {
  const tokens = realTokens(fs.readFileSync(mapPath, 'utf8'));
  if (!tokens.length) fail('map', `aucun jeton extrait de ${mapPath} : format de table inattendu`);

  const collisions = [];
  for (const [rel, txt] of files) {
    for (const t of tokens) {
      const i = occurrence(txt, t);
      if (i === null) continue;
      const ctx = txt.slice(Math.max(0, i - 60), i + 80).replace(/\s+/g, ' ');
      if (COMMON_WORDS.has(t.toLowerCase())) collisions.push(`${rel} : "${t}" dans …${ctx}…`);
      else fail(rel, `valeur réelle "${t}" présente : …${ctx}…`);
    }
  }
  return { count: tokens.length, collisions };
}

// ── Exécution ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const mapPath = argv.includes('--map') ? argv[argv.indexOf('--map') + 1] : null;

const scenarios = fs.readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (!scenarios.length) {
  console.error(`Aucun scénario dans ${DIR}`);
  process.exit(1);
}

const sources = [];
for (const name of scenarios) {
  const file = path.join(DIR, name, 'scenario.json');
  const txt = fs.readFileSync(file, 'utf8');
  sources.push([path.relative(ROOT, file).replace(/\\/g, '/'), txt]);
  let doc;
  try {
    doc = JSON.parse(txt);
  } catch (err) {
    fail(name, `JSON illisible : ${err.message}`);
    continue;
  }
  checkScenario(name, doc);
  console.log(`${name} : ${doc.events.length} événements, ${Object.keys(doc.geo).length} IP, ` +
    `${doc.expected.mustRaise.length} mustRaise, ${doc.expected.mustNotRaise.length} mustNotRaise`);
}

if (mapPath) {
  const { count, collisions } = checkLeaks(mapPath, sources);
  console.log(`\nTable de correspondance : ${count} valeurs réelles recherchées, aucune exemption.`);
  if (collisions.length) {
    console.log(`\n${collisions.length} collision(s) sur un mot courant, à relire (non bloquant) :`);
    for (const c of collisions) console.log(`  ${c}`);
  }
} else {
  console.log('\nContrôle de fuite non exécuté : relancer avec --map <table de correspondance hors dépôt>.');
}

if (problems.length) {
  console.error(`\n${problems.length} PROBLÈME(S) :`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nTout est conforme.');
