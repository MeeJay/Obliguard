import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Monitor, Apple, Download, ExternalLink, FolderOpen, Loader2, CheckCircle, AlertCircle, AlertTriangle,
  Server, Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import apiClient from '@/api/client';
import { agentApi, type AgentServedVersion } from '@/api/agent.api';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { cn } from '@/utils/cn';

// /download (mirrors Obliance DownloadPage): what this server actually serves,
// with versions and availability read from the server instead of static
// links.
//   - Obli.tools desktop app: version from GET /api/agent/desktop-version,
//     per-file availability + build date from a HEAD on /downloads/<file>
//     (server/src/app.ts, 404 when the build is absent).
//   - Obliguard agent: served version + missingBuilds (build manifest) from
//     GET /api/agent/version, per-file availability, build date and embedded
//     version (X-Agent-Version) from a HEAD on /api/agent/download/<file>.
// A missing build is shown disabled with a note instead of a dead link.

/** Obliguard product page on obli.tools: release notes and changelog. */
const RELEASE_NOTES_URL = 'https://guard.obli.tools';

// ── Native desktop-app Go bindings ───────────────────────────────────────────
// These are injected by the Go overlay into window when running inside Obliguard.

type NativeWindow = Window & {
  __obliguard_is_native_app?: boolean;
  /** Returns the currently saved download folder, or "" if not yet set. */
  __go_getDownloadDir?: () => Promise<string>;
  /** Opens a native OS folder-picker, saves the choice, returns the path. Rejects on cancel. */
  __go_chooseDownloadDir?: () => Promise<string>;
  /** Downloads relUrl from the Obliguard server to the saved folder (opens picker if unset). Returns the full path. */
  __go_downloadFile?: (relUrl: string, filename: string) => Promise<string>;
};

const nw = typeof window !== 'undefined' ? (window as NativeWindow) : null;
const isNativeApp = !!nw?.__obliguard_is_native_app;

// ── Availability probe ───────────────────────────────────────────────────────

type AvailabilityState = 'checking' | 'available' | 'missing' | 'unknown';

interface Availability {
  state: AvailabilityState;
  /** Last-Modified of the served file (build date), ISO-parsable. */
  builtAt?: string | null;
  /** Version the build manifest records for this artifact (agent files only). */
  version?: string | null;
}

/**
 * HEAD a download URL: 2xx with a non-HTML body = served. An HTML answer is
 * the SPA fallback (dev server without a proxy for the path), not the file;
 * 404 / 410 is the server saying the build is absent. Any other failure
 * (network error, 429 from a proxy, 5xx) leaves the entry usable
 * ('unknown'): never block a download on a failed probe.
 */
async function probeDownload(url: string): Promise<Availability> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 404 || res.status === 410 || type.includes('text/html')) return { state: 'missing' };
    if (!res.ok) return { state: 'unknown' };
    return {
      state: 'available',
      builtAt: res.headers.get('last-modified'),
      version: res.headers.get('x-agent-version'),
    };
  } catch {
    return { state: 'unknown' };
  }
}

// ── Static data ───────────────────────────────────────────────────────────────

interface DownloadEntry {
  label: string;      // format label, e.g. "Disk Image (.dmg)"
  sublabel: string;   // arch / OS note, e.g. "Apple Silicon (M1–M4)"
  filename: string;
  primary?: boolean;
}

interface Platform {
  name: string;
  icon: ReactNode;
  downloads: DownloadEntry[];
}

interface AgentArtifact {
  filename: string;
  platform: string;
  label: string;
  icon: ReactNode;
}

const DESKTOP_URL = (filename: string) => `/downloads/${filename}`;
const AGENT_URL = (filename: string) => `/api/agent/download/${filename}`;

// ── Component ─────────────────────────────────────────────────────────────────

export function DownloadPage() {
  const { t, i18n } = useTranslation();

  const PLATFORMS: Platform[] = [
    {
      name: t('download.windows'),
      icon: <Monitor size={24} />,
      downloads: [
        {
          label: t('download.installer'),
          sublabel: t('download.installerSub'),
          filename: 'ObliToolsSetup.msi',
          primary: true,
        },
        {
          label: t('download.portable'),
          sublabel: t('download.portableSub'),
          filename: 'ObliTools.exe',
        },
      ],
    },
    {
      name: t('download.macos'),
      icon: <Apple size={24} />,
      downloads: [
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.dmg',
          primary: true,
        },
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.dmg',
          primary: true,
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.zip',
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.zip',
        },
      ],
    },
  ];

  // Same allow-list as ALLOWED_AGENT_BINARIES (server/src/controllers/agent.controller.ts).
  const AGENT_ARTIFACTS: AgentArtifact[] = [
    {
      filename: 'obliguard-agent.msi',
      platform: t('download.windows'),
      label: t('download.agent.msi', { defaultValue: 'Installer (.msi) · x64' }),
      icon: <Monitor size={16} />,
    },
    {
      filename: 'obliguard-agent.exe',
      platform: t('download.windows'),
      label: t('download.agent.exe', { defaultValue: 'Bare binary (.exe) · x64' }),
      icon: <Monitor size={16} />,
    },
    {
      filename: 'obliguard-agent-linux-amd64',
      platform: t('download.agent.linux', { defaultValue: 'Linux' }),
      label: 'x86_64 (amd64)',
      icon: <Terminal size={16} />,
    },
    {
      filename: 'obliguard-agent-linux-arm64',
      platform: t('download.agent.linux', { defaultValue: 'Linux' }),
      label: 'ARM64 (aarch64)',
      icon: <Terminal size={16} />,
    },
    {
      filename: 'obliguard-agent-darwin-arm64',
      platform: t('download.macos'),
      label: t('download.dmgSubArm'),
      icon: <Apple size={16} />,
    },
    {
      filename: 'obliguard-agent-darwin-amd64',
      platform: t('download.macos'),
      label: t('download.dmgSubIntel'),
      icon: <Apple size={16} />,
    },
    {
      filename: 'obliguard-agent-freebsd-amd64',
      platform: t('download.agent.freebsd', { defaultValue: 'FreeBSD' }),
      label: 'x86_64 (amd64)',
      icon: <Server size={16} />,
    },
  ];

  // Versions served by this server
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  const [desktopVersionError, setDesktopVersionError] = useState(false);
  const [agentVersion, setAgentVersion] = useState<AgentServedVersion | null>(null);
  const [agentVersionError, setAgentVersionError] = useState(false);

  // Per-URL availability (HEAD probes)
  const [availability, setAvailability] = useState<Record<string, Availability>>({});

  // Native-app download folder state
  const [downloadDir, setDownloadDir] = useState<string>('');

  // Per-filename loading / success / error state
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});  // filename → saved path
  const [dlErrors, setDlErrors] = useState<Record<string, string>>({});

  // Versions + availability, once per mount.
  useEffect(() => {
    let cancelled = false;

    apiClient.get<{ version: string }>('/agent/desktop-version')
      .then((res) => {
        if (cancelled) return;
        // '0.0.0' = the server found neither obli.tools/VERSION nor main.go.
        const v = res.data?.version;
        if (v && v !== '0.0.0') setDesktopVersion(v);
        else setDesktopVersionError(true);
      })
      .catch(() => { if (!cancelled) setDesktopVersionError(true); });

    agentApi.getVersion()
      .then((info) => {
        if (cancelled) return;
        if (info?.version && info.version !== '0.0.0') setAgentVersion(info);
        else setAgentVersionError(true);
      })
      .catch(() => { if (!cancelled) setAgentVersionError(true); });

    const urls = [
      ...PLATFORMS.flatMap((p) => p.downloads.map((d) => DESKTOP_URL(d.filename))),
      ...AGENT_ARTIFACTS.map((a) => AGENT_URL(a.filename)),
    ];
    setAvailability(Object.fromEntries(urls.map((u) => [u, { state: 'checking' as const }])));
    for (const url of urls) {
      void probeDownload(url).then((a) => {
        if (!cancelled) setAvailability((prev) => ({ ...prev, [url]: a }));
      });
    }

    return () => { cancelled = true; };
    // PLATFORMS / AGENT_ARTIFACTS are rebuilt per render from static data:
    // probing once per mount is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount, read the saved download folder from Go config.
  useEffect(() => {
    if (!isNativeApp || !nw?.__go_getDownloadDir) return;
    nw.__go_getDownloadDir()
      .then(dir => setDownloadDir(dir))
      .catch((err: unknown) => console.warn('[download] reading the download folder failed', err));
  }, []);

  const handleChangeDir = async () => {
    const go = nw?.__go_chooseDownloadDir;
    if (!go) return;
    try {
      const dir = await go();
      setDownloadDir(dir);
    } catch {
      // cancelled — silently ignore
    }
  };

  const handleNativeDownload = async (relUrl: string, filename: string) => {
    const go = nw?.__go_downloadFile;
    if (!go) return;

    setDownloading(prev => ({ ...prev, [filename]: true }));
    setDlErrors(prev => { const n = { ...prev }; delete n[filename]; return n; });

    try {
      const dest = await go(relUrl, filename);
      setDownloaded(prev => ({ ...prev, [filename]: dest }));
      // After 6 s reset the "Saved" badge so the button is usable again.
      setTimeout(() => {
        setDownloaded(prev => { const n = { ...prev }; delete n[filename]; return n; });
      }, 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'cancelled') {
        setDlErrors(prev => ({ ...prev, [filename]: msg }));
      }
      // If the user opened the folder picker and chose a new folder, update the displayed dir.
      if (nw?.__go_getDownloadDir) {
        nw.__go_getDownloadDir().then(dir => setDownloadDir(dir)).catch((err: unknown) => console.warn('[download] reading the download folder failed', err));
      }
    } finally {
      setDownloading(prev => { const n = { ...prev }; delete n[filename]; return n; });
    }
  };

  const formatDate = useCallback((value: string | null | undefined): string | null => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(i18n.language);
  }, [i18n.language]);

  const missingNote = t('download.notAvailable', { defaultValue: 'Not available on this server' });
  const missingBuilds = new Set(agentVersion?.missingBuilds ?? []);

  /** A download control: native-app button, plain link, or disabled when the file is not served. */
  const renderDownload = (
    url: string,
    filename: string,
    className: string,
    inner: ReactNode,
    disabled: boolean,
  ) => {
    if (disabled) {
      return (
        <button type="button" disabled aria-disabled="true" className={className}>
          {inner}
        </button>
      );
    }
    if (isNativeApp) {
      return (
        <button
          type="button"
          onClick={() => handleNativeDownload(url, filename)}
          disabled={!!downloading[filename]}
          className={className}
        >
          {inner}
        </button>
      );
    }
    return (
      <a href={url} download={filename} className={className}>
        {inner}
      </a>
    );
  };

  const versionLine = (version: string | null, error: boolean) => (
    version
      ? <span className="font-mono">v{version}</span>
      : error
        ? <span className="text-amber-400">{t('download.versionUnavailable', { defaultValue: 'Version unavailable' })}</span>
        : <span>{t('download.loadingVersion', { defaultValue: 'Loading version…' })}</span>
  );

  return (
    <PageContainer className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        icon={<Download size={20} />}
        title={t('download.pageTitle', { defaultValue: 'Downloads' })}
        description={t('download.pageDescription', {
          defaultValue: 'The Obli.tools desktop app and the Obliguard agent builds served by this server.',
        })}
        actions={(
          <a
            href={RELEASE_NOTES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <ExternalLink size={14} />
            {t('download.releaseNotes', { defaultValue: 'Release notes' })}
          </a>
        )}
      />

      {/* ── Obli.tools desktop app ─────────────────────────────────────────── */}
      <section className="space-y-4" aria-labelledby="download-desktop">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="download-desktop" className="text-lg font-semibold text-text-primary">{t('download.title')}</h2>
            <span className="text-xs text-text-muted">{versionLine(desktopVersion, desktopVersionError)}</span>
          </div>
          <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{t('download.description')}</p>
        </div>

        {/* Download folder row — shown only inside the native app */}
        {isNativeApp && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary px-4 py-3 text-sm">
            <FolderOpen size={15} className="text-text-muted shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-text-secondary">{t('download.downloadFolder')}</span>
              {downloadDir
                ? <span className="font-mono text-text-primary break-all">{downloadDir}</span>
                : <span className="text-text-muted italic">{t('download.downloadFolderPlaceholder')}</span>
              }
            </div>
            <button
              type="button"
              onClick={handleChangeDir}
              className="shrink-0 rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('download.changeFolder')}
            </button>
          </div>
        )}

        {/* Feature pills */}
        <div className="flex flex-wrap gap-2">
          {[
            t('download.features.soundAlerts'),
            t('download.features.agentAlerts'),
            t('download.features.noBrowserOverhead'),
            t('download.features.remembersUrl'),
            t('download.features.alwaysUpToDate'),
          ].map((f) => (
            <span
              key={f}
              className="rounded-full border border-border bg-bg-secondary px-3 py-1 text-xs text-text-secondary"
            >
              {f}
            </span>
          ))}
        </div>

        {/* Download cards */}
        <div className="flex flex-col gap-4">
          {PLATFORMS.map((p) => (
            <div
              key={p.name}
              className="rounded-xl border border-border bg-bg-secondary p-5"
            >
              {/* Platform header */}
              <div className="mb-3 flex items-center gap-2.5 text-text-primary">
                <span className="text-text-secondary">{p.icon}</span>
                <span className="font-semibold">{p.name}</span>
              </div>

              {/* Download buttons — 2-column grid, tall buttons */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {p.downloads.map((d) => {
                  const url = DESKTOP_URL(d.filename);
                  const avail = availability[url] ?? { state: 'checking' };
                  const isMissing = avail.state === 'missing';
                  const isLoading = !!downloading[d.filename];
                  const isSaved   = !!downloaded[d.filename];
                  const hasError  = !!dlErrors[d.filename];
                  const builtAt   = formatDate(avail.builtAt);

                  const base    = 'flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-5 text-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full';
                  const primary = `${base} bg-accent font-semibold text-white enabled:hover:opacity-90 [&:not(button)]:hover:opacity-90`;
                  const secondary = `${base} border border-border bg-bg-tertiary text-text-secondary enabled:hover:bg-bg-hover enabled:hover:text-text-primary [&:not(button)]:hover:bg-bg-hover`;

                  const inner = isLoading ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      <span className="text-xs mt-0.5">{t('common.downloading')}</span>
                    </>
                  ) : isSaved ? (
                    <>
                      <CheckCircle size={15} className={d.primary ? 'text-white/80' : 'text-green-400'} />
                      <span className="text-xs mt-0.5">{t('common.saved')}</span>
                    </>
                  ) : (
                    <>
                      <Download size={15} />
                      <span className="text-xs font-semibold leading-tight mt-0.5">{d.label}</span>
                      <span className="text-xs leading-tight opacity-60">{d.sublabel}</span>
                    </>
                  );

                  return (
                    <div key={d.filename} className="flex flex-col">
                      {hasError && isNativeApp && (
                        <div className="mb-1 flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle size={10} />
                          <span className="truncate">{dlErrors[d.filename]}</span>
                        </div>
                      )}
                      {renderDownload(url, d.filename, d.primary ? primary : secondary, inner, isMissing)}
                      <div className="mt-1 min-h-4 text-center text-[11px] text-text-muted">
                        {avail.state === 'checking' && t('download.checking', { defaultValue: 'Checking availability…' })}
                        {isMissing && <span className="text-amber-400">{missingNote}</span>}
                        {avail.state === 'available' && builtAt
                          && t('download.builtOn', { date: builtAt, defaultValue: 'Built {{date}}' })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Obliguard agent builds ─────────────────────────────────────────── */}
      <section className="space-y-4" aria-labelledby="download-agent">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="download-agent" className="text-lg font-semibold text-text-primary">
              {t('download.agent.title', { defaultValue: 'Obliguard agent' })}
            </h2>
            <span className="text-xs text-text-muted">{versionLine(agentVersion?.version ?? null, agentVersionError)}</span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {t('download.agent.description', {
              defaultValue: 'Agent builds served by this server. To enrol a machine, use Add agent on the Agents page: it gives a one-line install command that carries your API key.',
            })}
            {' '}
            <Link to="/agents" className="text-accent hover:underline">
              {t('download.agent.openAgents', { defaultValue: 'Open Agents' })}
            </Link>
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
          {AGENT_ARTIFACTS.map((a) => {
            const url = AGENT_URL(a.filename);
            const avail = availability[url] ?? { state: 'checking' };
            const isMissing = avail.state === 'missing';
            const isOutdated = !isMissing && missingBuilds.has(a.filename);
            const isLoading = !!downloading[a.filename];
            const isSaved = !!downloaded[a.filename];
            const builtAt = formatDate(avail.builtAt);
            const artifactVersion = avail.version ?? null;

            const buttonClass = cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-bg-hover enabled:hover:text-text-primary [&:not(button)]:hover:bg-bg-hover [&:not(button)]:hover:text-text-primary',
            );
            const inner = isLoading ? (
              <><Loader2 size={13} className="animate-spin" />{t('common.downloading')}</>
            ) : isSaved ? (
              <><CheckCircle size={13} className="text-green-400" />{t('common.saved')}</>
            ) : (
              <><Download size={13} />{t('common.download')}</>
            );

            return (
              <div key={a.filename} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="text-text-muted" aria-hidden="true">{a.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary">
                    {a.platform} <span className="font-normal text-text-secondary">· {a.label}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">
                    <span className="font-mono">{a.filename}</span>
                    {artifactVersion && <span className="font-mono">v{artifactVersion}</span>}
                    {avail.state === 'available' && builtAt && (
                      <span>{t('download.builtOn', { date: builtAt, defaultValue: 'Built {{date}}' })}</span>
                    )}
                    {avail.state === 'checking' && <span>{t('download.checking', { defaultValue: 'Checking availability…' })}</span>}
                  </div>
                  {isMissing && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber-400">
                      <AlertTriangle size={12} className="shrink-0" />
                      {missingNote}
                    </div>
                  )}
                  {isOutdated && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber-400">
                      <AlertTriangle size={12} className="shrink-0" />
                      {t('download.agent.outdated', {
                        version: agentVersion?.version ?? '',
                        defaultValue: 'This build is not v{{version}}: agents on this platform are not offered the update.',
                      })}
                    </div>
                  )}
                  {dlErrors[a.filename] && isNativeApp && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-red-400">
                      <AlertCircle size={12} className="shrink-0" />
                      <span className="truncate">{dlErrors[a.filename]}</span>
                    </div>
                  )}
                </div>
                {renderDownload(url, a.filename, buttonClass, inner, isMissing)}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Release notes ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ExternalLink size={14} />
          {t('download.releaseNotes', { defaultValue: 'Release notes' })}
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">
          {t('download.releaseNotesDesc', {
            defaultValue: 'What changed in each version of Obliguard, its agent and the Obli.tools desktop app is published on obli.tools.',
          })}
          {' '}
          <a
            href={RELEASE_NOTES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            guard.obli.tools
            <ExternalLink size={12} />
          </a>
        </p>
      </div>

      {/* How it works */}
      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <div className="mb-3 text-sm font-semibold text-text-primary">{t('download.howItWorks')}</div>
        <ol className="space-y-2 text-sm text-text-secondary">
          {(['step1', 'step2', 'step3', 'step4', 'step5'] as const).map((key, i) => (
            <li key={key} className="flex gap-2">
              <span className="mt-0.5 shrink-0 text-primary">{i + 1}.</span>
              {t(`download.${key}`)}
            </li>
          ))}
        </ol>
      </div>
    </PageContainer>
  );
}
