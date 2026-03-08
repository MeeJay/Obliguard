import { useEffect, useRef, useState, useCallback } from 'react';
import { Network, RefreshCw, ZoomIn, ZoomOut, Maximize2, Info } from 'lucide-react';
import toast from 'react-hot-toast';

// We load Cytoscape dynamically from CDN to avoid adding a build dependency.
// The type is loosely declared here.
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cytoscape?: any;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface IpReputationItem {
  ip: string;
  totalFailures: number;
  affectedServices: string[];
  affectedAgentsCount: number;
  status?: string;
  geoCountryCode?: string | null;
}

interface AgentDevice {
  id: number;
  hostname: string;
  name: string | null;
  status: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSubnet24(ip: string): string {
  const parts = ip.split('.');
  if (parts.length < 3) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function ipNodeColor(status: string | undefined): string {
  switch (status) {
    case 'banned':      return '#ef4444';
    case 'suspicious':  return '#eab308';
    case 'whitelisted': return '#22c55e';
    default:            return '#6b7280';
  }
}

function countryCodeToFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(c.codePointAt(0)! + offset))
    .join('');
}

// ── Load Cytoscape from CDN ───────────────────────────────────────────────────

function loadCytoscape(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.cytoscape) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.29.2/cytoscape.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Cytoscape'));
    document.head.appendChild(script);
  });
}

// ── NetMapPage ────────────────────────────────────────────────────────────────

export function NetMapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [cyReady, setCyReady] = useState(false);
  const [selectedNode, setSelectedNode] = useState<{
    type: 'ip' | 'agent' | 'subnet';
    id: string;
    label: string;
    details: Record<string, string | number>;
  } | null>(null);
  const [stats, setStats] = useState({ agents: 0, ips: 0, banned: 0, subnets: 0 });

  const buildGraph = useCallback(async () => {
    setLoading(true);
    try {
      // Load Cytoscape if needed
      await loadCytoscape();
      setCyReady(true);

      // Fetch data in parallel
      const [repRes, devRes] = await Promise.all([
        fetch('/api/ip-reputation?limit=200'),
        fetch('/api/agent/devices'),
      ]);

      const repJson = repRes.ok ? await repRes.json() : { data: [] };
      const devJson = devRes.ok ? await devRes.json() : { data: [] };

      const ips: IpReputationItem[] = repJson.data ?? [];
      const agents: AgentDevice[] = devJson.data ?? [];

      // Build elements
      const elements: object[] = [];
      const subnetSet = new Set<string>();

      // Agent nodes
      for (const agent of agents) {
        if (agent.status !== 'approved') continue;
        elements.push({
          data: {
            id: `agent-${agent.id}`,
            label: agent.name ?? agent.hostname,
            type: 'agent',
            color: '#3b82f6',
          },
        });
      }

      // IP nodes + subnet compound nodes
      for (const rep of ips) {
        const subnet = getSubnet24(rep.ip);
        if (!subnetSet.has(subnet)) {
          subnetSet.add(subnet);
          elements.push({
            data: { id: `subnet-${subnet}`, label: subnet, type: 'subnet' },
          });
        }

        elements.push({
          data: {
            id: `ip-${rep.ip}`,
            label: rep.ip,
            parent: `subnet-${subnet}`,
            type: 'ip',
            status: rep.status ?? 'clean',
            color: ipNodeColor(rep.status),
            failures: rep.totalFailures,
            services: (rep.affectedServices ?? []).join(', '),
            flag: countryCodeToFlag(rep.geoCountryCode),
          },
        });

        // Edges: connect IP to agents that reported it (we use affectedAgentsCount as approximate)
        if (rep.affectedAgentsCount > 0) {
          for (const agent of agents.slice(0, rep.affectedAgentsCount)) {
            if (agent.status !== 'approved') continue;
            elements.push({
              data: {
                id: `e-${agent.id}-${rep.ip}`,
                source: `agent-${agent.id}`,
                target: `ip-${rep.ip}`,
                service: (rep.affectedServices ?? [])[0] ?? 'unknown',
              },
            });
          }
        }
      }

      setStats({
        agents: agents.filter(a => a.status === 'approved').length,
        ips: ips.length,
        banned: ips.filter(r => r.status === 'banned').length,
        subnets: subnetSet.size,
      });

      if (!containerRef.current || !window.cytoscape) return;

      // Destroy previous instance
      if (cyRef.current) { cyRef.current.destroy(); }

      // Initialize Cytoscape
      const cy = window.cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: 'node[type = "subnet"]',
            style: {
              'background-color': '#1e293b',
              'border-color': '#334155',
              'border-width': 1,
              'label': 'data(label)',
              'color': '#64748b',
              'font-size': '10px',
              'text-valign': 'top',
              'padding': '20px',
            },
          },
          {
            selector: 'node[type = "ip"]',
            style: {
              'background-color': 'data(color)',
              'border-color': 'data(color)',
              'border-width': 2,
              'label': 'data(label)',
              'color': '#f1f5f9',
              'font-size': '9px',
              'width': 28,
              'height': 28,
              'text-valign': 'bottom',
              'text-margin-y': 4,
            },
          },
          {
            selector: 'node[type = "agent"]',
            style: {
              'background-color': '#3b82f6',
              'border-color': '#60a5fa',
              'border-width': 2,
              'label': 'data(label)',
              'color': '#f1f5f9',
              'font-size': '10px',
              'width': 36,
              'height': 36,
              'shape': 'rectangle',
              'text-valign': 'bottom',
              'text-margin-y': 4,
            },
          },
          {
            selector: 'edge',
            style: {
              'line-color': '#475569',
              'width': 1,
              'opacity': 0.5,
              'curve-style': 'bezier',
            },
          },
          {
            selector: ':selected',
            style: {
              'border-color': '#f59e0b',
              'border-width': 3,
            },
          },
        ],
        layout: {
          name: 'cose',
          animate: true,
          animationDuration: 600,
          nodeRepulsion: () => 5000,
          idealEdgeLength: () => 80,
          nodeOverlap: 10,
          gravity: 0.3,
        },
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        minZoom: 0.1,
        maxZoom: 4,
      });

      cyRef.current = cy;

      // Node click handler
      cy.on('tap', 'node', (evt: { target: { data: () => { id?: string; type: string; label: string; status?: string; failures?: number; services?: string } } }) => {
        const node = evt.target;
        const d = node.data();
        setSelectedNode({
          type: d.type as 'ip' | 'agent' | 'subnet',
          id: d.id as string,
          label: d.label as string,
          details: d.type === 'ip'
            ? { Status: d.status ?? 'clean', Failures: d.failures ?? 0, Services: d.services ?? '—' }
            : d.type === 'agent'
              ? { Role: 'Agent', Status: 'Approved' }
              : { Type: 'Subnet /24' },
        });
      });

      cy.on('tap', (evt: { target: { isNode: () => boolean } }) => {
        if (evt.target === cy) setSelectedNode(null);
      });

    } catch (err) {
      console.error(err);
      toast.error('Failed to build network map');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void buildGraph();
    return () => { if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; } };
  }, [buildGraph]);

  function handleZoomIn() { cyRef.current?.zoom(cyRef.current.zoom() * 1.3); }
  function handleZoomOut() { cyRef.current?.zoom(cyRef.current.zoom() * 0.7); }
  function handleFit() { cyRef.current?.fit(undefined, 40); }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <Network size={20} className="text-text-muted" />
            Network Map
          </h1>
          {!loading && (
            <p className="text-xs text-text-muted mt-0.5">
              {stats.agents} agents · {stats.ips} IPs · {stats.banned} banned · {stats.subnets} subnets
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void buildGraph()}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={handleZoomIn} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Zoom in">
            <ZoomIn size={14} />
          </button>
          <button onClick={handleZoomOut} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button onClick={handleFit} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Fit view">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 shrink-0 text-xs text-text-muted">
        {[
          { color: '#3b82f6', label: 'Agent' },
          { color: '#ef4444', label: 'Banned IP' },
          { color: '#eab308', label: 'Suspicious IP' },
          { color: '#22c55e', label: 'Whitelisted IP' },
          { color: '#6b7280', label: 'Clean IP' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* Map + Panel */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Cytoscape container */}
        <div className="relative flex-1 rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {loading && !cyReady && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="text-center">
                <Network size={48} className="text-text-muted mx-auto mb-3 animate-pulse" />
                <p className="text-sm text-text-muted">Building network map...</p>
              </div>
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
        </div>

        {/* Node detail panel */}
        {selectedNode && (
          <div className="w-64 shrink-0 rounded-xl border border-border bg-bg-secondary p-4 overflow-y-auto">
            <div className="flex items-center gap-2 mb-3">
              <Info size={14} className="text-text-muted" />
              <h3 className="text-sm font-semibold text-text-primary truncate">{selectedNode.label}</h3>
            </div>
            <div className="space-y-2">
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1">Type</p>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  selectedNode.type === 'agent' ? 'bg-blue-500/15 text-blue-400' :
                  selectedNode.type === 'ip' ? 'bg-red-500/15 text-red-400' :
                  'bg-bg-tertiary text-text-muted'
                }`}>
                  {selectedNode.type}
                </span>
              </div>
              {Object.entries(selectedNode.details).map(([k, v]) => (
                <div key={k}>
                  <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-0.5">{k}</p>
                  <p className="text-xs text-text-secondary font-mono">{String(v)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
