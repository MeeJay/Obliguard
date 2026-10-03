#!/usr/bin/env node
/**
 * Agent build manifest helper, called by the Windows build scripts
 * (000-RegularUpdate.bat, agent/build-msi.bat). The .sh build scripts write
 * the same format themselves (write_manifest in build*.sh).
 *
 *   node scripts/agent-manifest.mjs write <version> <file>...
 *       Merge these dist/ artifacts (sha256, size, version) into
 *       dist/manifest.json, keeping the entries of artifacts built elsewhere.
 *
 *   node scripts/agent-manifest.mjs check <version>
 *       Merge dist/manifest.json + dist/manifest.<host>.json (oldest mtime
 *       first, like the server) and list the update artifacts that do not
 *       embed <version>. Exit 0 when all match, 2 when some are stale. The
 *       server never advertises an update to a stale platform, so callers
 *       treat 2 as a warning.
 *
 * Run from agent/. No dependency besides Node.
 */
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const DIST = 'dist';
const MANIFEST = path.join(DIST, 'manifest.json');
const UPDATE_ARTIFACTS = [
  'obliguard-agent.msi',
  'obliguard-agent-linux-amd64',
  'obliguard-agent-linux-arm64',
  'obliguard-agent-darwin-amd64',
  'obliguard-agent-darwin-arm64',
  'obliguard-agent-freebsd-amd64',
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function write(version, files) {
  const current = readJson(MANIFEST);
  const artifacts = (current && typeof current.artifacts === 'object' && current.artifacts) || {};
  for (const f of files) {
    const p = path.join(DIST, path.basename(f));
    if (!fs.existsSync(p)) {
      console.error(`Manifest: ${p} missing, entry not written`);
      continue;
    }
    const buf = fs.readFileSync(p);
    artifacts[path.basename(f)] = {
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      version,
    };
  }
  // One artifact per line: the format the .sh write_manifest functions merge.
  const lines = Object.keys(artifacts).sort().map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(artifacts[k])}`);
  const out = `{\n  "version": ${JSON.stringify(version)},\n  "artifacts": {\n${lines.join(',\n')}\n  }\n}\n`;
  fs.writeFileSync(`${MANIFEST}.tmp`, out);
  fs.renameSync(`${MANIFEST}.tmp`, MANIFEST);
  console.log(`Manifest: ${MANIFEST} (${files.length} artifact(s) at v${version})`);
}

function check(version) {
  const names = fs.existsSync(DIST)
    ? fs.readdirSync(DIST).filter((n) => /^manifest(\.[A-Za-z0-9_-]{1,32})?\.json$/.test(n))
    : [];
  const merged = {};
  for (const n of names.sort((a, b) => fs.statSync(path.join(DIST, a)).mtimeMs - fs.statSync(path.join(DIST, b)).mtimeMs)) {
    const m = readJson(path.join(DIST, n));
    if (m && typeof m.artifacts === 'object' && m.artifacts) Object.assign(merged, m.artifacts);
  }
  const stale = UPDATE_ARTIFACTS.filter((f) => merged[f]?.version !== version);
  if (stale.length === 0) {
    console.log(`Manifest: all agent builds at v${version}`);
    return 0;
  }
  for (const f of stale) {
    const have = merged[f]?.version;
    console.log(`Manifest: ${f} ${have ? `is v${have}` : 'missing'} (expected v${version}) -> not offered as an update`);
  }
  return 2;
}

const [cmd, version, ...files] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: agent-manifest.mjs write <x.y.z> <file>... | check <x.y.z>');
  process.exit(1);
}
if (cmd === 'write') write(version, files);
else if (cmd === 'check') process.exit(check(version));
else { console.error(`unknown command ${cmd}`); process.exit(1); }
