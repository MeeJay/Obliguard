import { Router } from 'express';

const router = Router();

/**
 * POST /api/geo/batch
 * Proxies a batch geolocation request to ip-api.com.
 * Expects body: { ips: string[] }  (max 100)
 * Returns: { data: { query: string; countryCode: string }[] }
 */
router.post('/batch', async (req, res) => {
  const ips: string[] = (Array.isArray(req.body?.ips) ? req.body.ips : []).slice(0, 100);
  if (!ips.length) { res.json({ data: [] }); return; }

  try {
    const payload = ips.map(ip => ({ query: ip, fields: 'query,countryCode' }));
    const r = await fetch('http://ip-api.com/batch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(6000),
    });
    const raw: unknown = await r.json();
    res.json({ data: raw });
  } catch {
    res.json({ data: [] });
  }
});

export default router;
