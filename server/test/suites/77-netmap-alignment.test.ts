/**
 * 77 — W9-4 NetMap aligned with the app (client side, static checks):
 *   77.1 palette: no colour literal outside netmap/constants.ts and
 *        netmap3d/constants3d.ts (NetMapPage, netmap/*, netmap3d/*)
 *   77.2 safe labels: no innerHTML-family sink, the 3D agent label is set
 *        through textContent
 *   77.3 unified dialogs and drawer: no native dialog, Ban through useConfirm
 *        gated by canBan, Whitelist through the drawer's prompt flow gated by
 *        canWhitelist, an IP click opens the shared IP drawer, the
 *        "View in IP Reputation" link is /ip-reputation?search=<encoded>
 *   77.4 socket contract: SOCKET_EVENTS constants only (ip:events batched,
 *        ip:flow fallback only until ip:events is seen, ban events), no
 *        per-heartbeat REST refetch of /ip-events or /bans/stats
 *   77.5 i18n: no hard-coded English text node in the NetMap JSX, labels
 *        through t('netmap.*', { defaultValue })
 *   77.6 3D parity: evaluate-only marker (2D + 3D), threat tint, filters
 *        read from live refs, instance → IP mapping, search fly-to, growable
 *        IP pool, hover tooltip
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/** Source without block / line comments (a comment may mention innerHTML). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const PAGE = 'client/src/pages/NetMapPage.tsx';
const PALETTE_FILES = new Set(['client/src/netmap/constants.ts', 'client/src/netmap3d/constants3d.ts']);

/** Every source file of the NetMap: the page, netmap/* and netmap3d/*. */
function netmapFiles(): string[] {
  const out = [PAGE];
  for (const dir of ['client/src/netmap', 'client/src/netmap3d']) {
    for (const f of fs.readdirSync(path.join(REPO, dir))) {
      if (/\.tsx?$/.test(f)) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** Body of `const <name> = (...) => { ... };` (brace-matched). */
function arrowBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf('{', src.indexOf('=>', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

describe('77 NetMap alignment (W9-4)', () => {
  lotIt('W9-4', '77.1 no colour literal outside the NetMap palette files', () => {
    for (const rel of netmapFiles()) {
      if (PALETTE_FILES.has(rel)) continue;
      const src = code(rel);
      // '#rgb' / '#rrggbb' / '#rrggbbaa' string colours
      const hex = src.match(/['"`]#[0-9a-fA-F]{3,8}['"`]/g) ?? [];
      assert.deepEqual(hex, [], `${rel}: hex colour literal`);
      // Hard-coded rgb()/rgba() strings (palette rgba() helper calls are fine)
      const rgbStr = src.match(/['"`]rgba?\(\s*\d/g) ?? [];
      assert.deepEqual(rgbStr, [], `${rel}: rgb()/rgba() colour literal`);
      // Three.js colour numbers (0xffffffff bit masks are 8 digits, not colours)
      const threeHex = src.match(/\b0x[0-9a-fA-F]{6}\b/g) ?? [];
      assert.deepEqual(threeHex, [], `${rel}: 0xRRGGBB colour literal`);
      // Tailwind arbitrary hex classes
      const twHex = src.match(/-\[#[0-9a-fA-F]{3,8}\]/g) ?? [];
      assert.deepEqual(twHex, [], `${rel}: Tailwind arbitrary hex class`);
    }
    const palette = code('client/src/netmap/constants.ts');
    assert.match(palette, /export const NETMAP_PALETTE = \{/);
    assert.match(palette, /export const NETMAP_CSS_VARS/);
    assert.match(code('client/src/netmap3d/constants3d.ts'), /export const PALETTE_3D = \{/);
    assert.match(code(PAGE), /style=\{NETMAP_CSS_VARS as CSSProperties\}/, 'page chrome reads the palette CSS variables');
  });

  lotIt('W9-4', '77.2 labels are never rendered as markup', () => {
    for (const rel of netmapFiles()) {
      const src = code(rel);
      assert.doesNotMatch(src, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|dangerouslySetInnerHTML|document\.write\(/, `${rel}: markup sink`);
    }
    const mesh = code('client/src/netmap3d/agentMesh.ts');
    assert.match(mesh, /nameEl\.textContent = agent\.label/, '3D agent name set as text');
    assert.match(mesh, /stateEl\.textContent = /);
    assert.match(mesh, /evalEl\.textContent = /);
  });

  lotIt('W9-4', '77.3 unified dialogs, permissions and the shared IP drawer', () => {
    for (const rel of netmapFiles()) {
      assert.doesNotMatch(code(rel), /window\.(?:confirm|prompt|alert)\b|\balert\(/, `${rel}: native dialog`);
    }
    const src = code(PAGE);
    assert.match(src, /useIpsPermissions\(\)/);
    assert.match(src, /const confirm = useConfirm\(\);/);
    assert.match(src, /if \(!canBan\) return;\s*const shownIp = anonIp\(ip\);\s*const ok = await confirm\(/, 'quick ban: capability, then confirm dialog');
    assert.match(src, /if \(!canWhitelist\) return;[\s\S]{0,200}ipActions\.whitelist\(\{ ip \}\)/, 'quick whitelist: capability, then the drawer prompt flow');
    assert.match(src, /\{canWhitelist && clickedIp\.status !== 'whitelisted' && \(/);
    // IP clicks (canvas, 3D, live feed, agent panel) go through the shared drawer
    assert.match(src, /useIpDrawer\(\)/);
    assert.match(src, /const showIp = useCallback\(\(ip: string\) => \{[\s\S]{0,120}openIpDrawer\(ip\);/);
    assert.match(src, /showIpRef\.current\(ip\.ip\);/, 'canvas / 3D IP click opens the drawer');
    assert.match(src, /onClick=\{\(\) => showIp\(ev\.ip\)\}/, 'live feed IP opens the drawer');
    assert.match(src, /useIpChanged\(/, 'drawer actions refresh the map');
    assert.match(src, /to=\{`\/ip-reputation\?search=\$\{encodeURIComponent\(clickedIp\.ip\)\}`\}/);
    // The tab editor is the app modal; deleting a view is confirmed
    const dialog = code('client/src/netmap/NetMapTabDialog.tsx');
    assert.match(dialog, /<Modal\b/);
    assert.match(dialog, /await confirm\(\{[\s\S]{0,300}danger: true/);
  });

  lotIt('W9-4', '77.4 socket constants, batched ip:events, no per-heartbeat refetch', () => {
    const src = code(PAGE);
    assert.doesNotMatch(src, /['"](?:ip:flow|ip:events|ban:auto|ban:created|ban:lifted|agent:pushHeartbeat|agent:statusChanged)['"]/, 'raw socket event literal');
    for (const ev of ['IP_EVENTS', 'IP_FLOW', 'BAN_AUTO', 'BAN_CREATED', 'BAN_LIFTED', 'AGENT_PUSH_HEARTBEAT']) {
      assert.match(src, new RegExp(`socket\\.on\\(SOCKET_EVENTS\\.${ev},`), `listens to SOCKET_EVENTS.${ev}`);
      assert.match(src, new RegExp(`socket\\.off\\(SOCKET_EVENTS\\.${ev},`), `unbinds SOCKET_EVENTS.${ev}`);
    }
    // ip:flow is only a fallback until the server proves it sends ip:events
    assert.match(arrowBody(src, 'onIpEvents'), /ipEventsSeenRef\.current = true;/);
    assert.match(arrowBody(src, 'onIpFlow'), /if \(ipEventsSeenRef\.current\) return;/);
    // The heartbeat is an online pulse only: no REST call
    const heartbeat = arrowBody(src, 'onPushHeartbeat');
    assert.doesNotMatch(heartbeat, /apiClient|setTimeout|\/ip-events|\/bans\/stats/);
    // /bans/stats is read by the initial load and the 90 s soft refresh only
    assert.equal((src.match(/'\/bans\/stats'/g) ?? []).length, 2, '/bans/stats: init + soft refresh');
    assert.match(src, /setInterval\(\(\) => \{ void softRefresh\(\); \}, 90_000\)/);
    // Stream rows carry ids: duplicates of the initial load are dropped
    assert.match(src, /if \(row\.id != null && !rememberEventId\(row\.id\)\) continue;/);
    // A bulk lift (count only, every tenant) is re-read, never applied to every banned node
    const bulk = arrowBody(src, 'onBanBulkLifted');
    assert.match(bulk, /softRefreshRef\.current\(\)/);
    assert.doesNotMatch(bulk, /setIpStatus/);
  });

  lotIt('W9-4', '77.5 NetMap labels go through i18n', () => {
    const allowed = new Set(['AbuseIPDB', 'Shodan', 'VirusTotal']);
    for (const rel of [PAGE, 'client/src/netmap/NetMapTabDialog.tsx', 'client/src/netmap3d/NetMap3D.tsx']) {
      const src = code(rel);
      const offenders: string[] = [];
      // JSX text nodes with words (expressions are in braces, not matched)
      for (const m of src.matchAll(/>([^<>{}]*)</g)) {
        const text = m[1].trim();
        if (!/[A-Za-z]{2,}/.test(text)) continue;
        if (/=>|&&|\|\||[;()=]/.test(m[1])) continue; // TS generics / code, not JSX text
        if (allowed.has(text)) continue;
        offenders.push(text);
      }
      assert.deepEqual(offenders, [], `${rel}: hard-coded JSX text`);
      // Attribute strings shown to the user
      assert.doesNotMatch(src, /\b(?:title|placeholder|aria-label)="[^"]*[A-Za-z]{3,}[^"]*"/, `${rel}: hard-coded attribute text`);
    }
    const src = code(PAGE);
    assert.ok((src.match(/t\('netmap\./g) ?? []).length >= 60, 'netmap.* keys used');
    assert.doesNotMatch(src, /toast\.(?:error|success)\(\s*['"`]/, 'toast with a literal message');
    // Canvas labels are translated too (read from a ref by the draw loop)
    assert.match(src, /canvasTextRef\.current = \{/);
    assert.doesNotMatch(src, /fillText\('OFFLINE'/);
  });

  lotIt('W9-4', '77.6 3D parity: evaluate-only, threat tint, live filters, search, pool', () => {
    assert.match(code('client/src/netmap/types.ts'), /evaluateOnly: boolean;/);
    const page = code(PAGE);
    assert.match(page, /evaluateOnly:\s+d\.evaluateOnly === true/, 'evaluate-only mapped from /agent/devices');
    assert.match(page, /if \(agent\.evaluateOnly\) \{/, '2D evaluate-only ring');

    const mesh = code('client/src/netmap3d/agentMesh.ts');
    assert.match(mesh, /agent\.evaluateOnly \? labels\.evaluateOnly : ''/, '3D evaluate-only label');
    assert.match(mesh, /lerp\(threatColor, tint\)/, '3D threat tint');
    assert.match(mesh, /a3d\.label\.element\.remove\(\)/, 'a removed agent drops its label element');

    const view = code('client/src/netmap3d/NetMap3D.tsx');
    assert.match(view, /propsRef\.current = props;/, 'loop reads the latest props');
    assert.match(view, /propsRef\.current\.threatOnly/);
    assert.match(view, /propsRef\.current\.visibleAgentIds/);
    assert.match(view, /renderedIpsRef\.current\[hit\.index\]/, 'instance id resolved through the rendered IPs');
    assert.match(view, /\}, \[searchHit, ipsRef, agentsRef\]\);/, 'search hit flies the camera');
    assert.match(view, /setHover\(/, 'hover tooltip');

    const pool = code('client/src/netmap3d/ipMesh.ts');
    assert.match(pool, /private grow\(needed: number\)/);
    assert.match(pool, /IP_POOL_MAX/);
    assert.match(code('client/src/netmap3d/interactions.ts'), /onHover\(pick\(\), pos\.x, pos\.y\)/);
  });
});
