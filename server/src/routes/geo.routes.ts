import { Router } from 'express';
import { db } from '../db';
import { logger } from '../utils/logger';
import { geoipService, geoLookupCandidate } from '../services/geoip.service';
import { ipReputationService } from '../services/ipReputation.service';

const router = Router();

const MAX_IPS = 100;

/**
 * POST /api/geo/batch
 * Country codes for NetMap badges. Served from ip_reputation first; only the
 * IPs it has no country for go through geoip.service (cache, rate limit,
 * private / reserved IPs never looked up), and fresh results are persisted
 * back into ip_reputation.
 * Expects body: { ips: string[] }  (max 100)
 * Returns: { data: { query: string; countryCode: string }[] } (unknown IPs omitted)
 */
router.post('/batch', async (req, res) => {
  const raw: unknown[] = (Array.isArray(req.body?.ips) ? req.body.ips : []).slice(0, MAX_IPS);
  // normalized address -> the spellings the client sent (echoed back as `query`)
  const asked = new Map<string, string[]>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const ip = geoLookupCandidate(v);
    if (!ip) continue;
    const list = asked.get(ip);
    if (list) list.push(v); else asked.set(ip, [v]);
  }
  if (asked.size === 0) { res.json({ data: [] }); return; }

  try {
    const known = new Map<string, string>();
    const rows = await db.raw(
      `SELECT host(ip) AS ip, geo_country_code FROM ip_reputation
        WHERE ip = ANY(?::inet[]) AND geo_country_code IS NOT NULL`,
      [[...asked.keys()]],
    ) as { rows: Array<{ ip: string; geo_country_code: string }> };
    for (const r of rows.rows) {
      const ip = geoLookupCandidate(r.ip);
      if (ip) known.set(ip, r.geo_country_code);
    }

    const missing = [...asked.keys()].filter((ip) => !known.has(ip));
    if (missing.length > 0) {
      const found = await geoipService.lookupMany(missing);
      for (const [ip, info] of found) {
        if (info?.countryCode) known.set(ip, info.countryCode);
      }
      ipReputationService.persistGeo(found)
        .catch((err) => logger.warn({ err }, 'GeoIP: persisting /geo/batch results failed'));
    }

    const data: Array<{ query: string; countryCode: string }> = [];
    for (const [ip, countryCode] of known) {
      for (const query of asked.get(ip) ?? []) data.push({ query, countryCode });
    }
    res.json({ data });
  } catch (err) {
    logger.warn({ err }, 'GeoIP: /geo/batch failed');
    res.json({ data: [] });
  }
});

export default router;
