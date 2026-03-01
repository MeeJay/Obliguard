import { useState, useRef, useCallback } from 'react';
import { Download, Upload, FileJson, CheckCircle2, PackageOpen } from 'lucide-react';
import { Button } from '@/components/common/Button';
import apiClient from '@/api/client';
import toast from 'react-hot-toast';

// ── Types ─────────────────────────────────────────────────────────────────────

type Section =
  | 'monitorGroups'
  | 'monitors'
  | 'settings'
  | 'notificationChannels'
  | 'agentGroups'
  | 'teams';

type ConflictStrategy = 'update' | 'generateNew' | 'ignore';

const ALL_SECTIONS: Section[] = [
  'monitorGroups',
  'monitors',
  'settings',
  'notificationChannels',
  'agentGroups',
  'teams',
];

const SECTION_LABELS: Record<Section, string> = {
  monitorGroups:       'Monitor Groups',
  monitors:            'Monitors',
  settings:            'Settings',
  notificationChannels:'Notification Channels',
  agentGroups:         'Agent Groups',
  teams:               'Teams',
};

const CONFLICT_OPTIONS: { value: ConflictStrategy; label: string; description: string }[] = [
  {
    value:       'update',
    label:       'Update existing',
    description: 'When a UUID matches an existing record, overwrite it with the imported data.',
  },
  {
    value:       'generateNew',
    label:       'Generate new copy',
    description: 'When a UUID matches an existing record, create a brand-new duplicate with a fresh UUID.',
  },
  {
    value:       'ignore',
    label:       'Skip duplicates',
    description: 'When a UUID matches an existing record, skip that item entirely.',
  },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked:        boolean;
  indeterminate?: boolean;
  onChange:       (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors duration-200 focus:outline-none focus-visible:ring-2',
        'focus-visible:ring-accent focus-visible:ring-offset-2',
        checked
          ? 'bg-accent'
          : indeterminate
            ? 'bg-accent/40'
            : 'bg-bg-tertiary border border-border',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-block h-4 w-4 transform rounded-full',
          'bg-white shadow-lg ring-0 transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

function SectionSelector({
  sections,
  enabled,
  onToggle,
  onToggleAll,
}: {
  sections:     Section[];
  enabled:      Set<Section>;
  onToggle:     (s: Section) => void;
  onToggleAll:  (on: boolean) => void;
}) {
  const allOn  = sections.length > 0 && sections.every(s => enabled.has(s));
  const someOn = sections.some(s => enabled.has(s));

  return (
    <div className="space-y-1">
      {/* All toggle */}
      <div className="flex items-center justify-between py-2 border-b border-border">
        <span className="text-sm font-medium text-text-primary">All</span>
        <Toggle
          checked={allOn}
          indeterminate={!allOn && someOn}
          onChange={onToggleAll}
        />
      </div>

      {/* Individual sections */}
      {sections.map((s) => (
        <div key={s} className="flex items-center justify-between py-1.5">
          <span className="text-sm text-text-secondary">{SECTION_LABELS[s]}</span>
          <Toggle checked={enabled.has(s)} onChange={() => onToggle(s)} />
        </div>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function ImportExportPage() {

  // ── Export state ──
  const [exportSections, setExportSections] = useState<Set<Section>>(new Set(ALL_SECTIONS));
  const [exporting,      setExporting]      = useState(false);

  // ── Import state ──
  const [importFile,       setImportFile]       = useState<File | null>(null);
  const [importData,       setImportData]       = useState<Record<string, unknown> | null>(null);
  const [availableSections,setAvailableSections]= useState<Section[]>([]);
  const [importSections,   setImportSections]   = useState<Set<Section>>(new Set());
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>('update');
  const [importing,        setImporting]        = useState(false);
  const [importResults,    setImportResults]    = useState<
    Record<string, { created: number; updated: number; skipped: number }> | null
  >(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Export handlers ──────────────────────────────────────────────────────

  const toggleExportSection = useCallback((s: Section) => {
    setExportSections(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const toggleAllExport = useCallback((on: boolean) => {
    setExportSections(on ? new Set(ALL_SECTIONS) : new Set());
  }, []);

  const handleExport = useCallback(async () => {
    if (exportSections.size === 0) {
      toast.error('Select at least one section to export');
      return;
    }
    setExporting(true);
    try {
      const sections = [...exportSections].join(',');
      const res = await apiClient.get(
        `/admin/export?sections=${encodeURIComponent(sections)}`,
        { responseType: 'blob' },
      );
      const url = URL.createObjectURL(res.data as Blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `obliview-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Export downloaded');
    } catch {
      toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  }, [exportSections]);

  // ── Import handlers ──────────────────────────────────────────────────────

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFile(file);
    setImportResults(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string) as Record<string, unknown>;
        if (typeof json !== 'object' || Array.isArray(json)) throw new Error('Not an object');

        const available = ALL_SECTIONS.filter(s => Array.isArray(json[s]));
        setAvailableSections(available);
        setImportSections(new Set(available));
        setImportData(json);
      } catch {
        toast.error('Invalid export file — expected Obliview JSON export');
        setImportFile(null);
        setImportData(null);
        setAvailableSections([]);
        setImportSections(new Set());
        // Reset file input so the same file can be re-selected after error
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  }, []);

  const toggleImportSection = useCallback((s: Section) => {
    setImportSections(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const toggleAllImport = useCallback((on: boolean) => {
    setImportSections(on ? new Set(availableSections) : new Set());
  }, [availableSections]);

  const handleImport = useCallback(async () => {
    if (!importData) {
      toast.error('Please choose an export file first');
      return;
    }
    if (importSections.size === 0) {
      toast.error('Select at least one section to import');
      return;
    }
    setImporting(true);
    setImportResults(null);
    try {
      const res = await apiClient.post('/admin/import', {
        sections:         [...importSections],
        data:             importData,
        conflictStrategy,
      });
      setImportResults(res.data.data);
      toast.success('Import completed successfully');
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [importData, importSections, conflictStrategy]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">

      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <PackageOpen size={22} className="text-accent" />
          <h1 className="text-2xl font-semibold text-text-primary">Import / Export</h1>
        </div>
        <p className="text-sm text-text-muted">
          Export your configuration to a portable JSON file, or import a previously saved file.
          UUIDs in the file enable idempotent re-imports — existing records are updated rather
          than duplicated. UUIDs are optional when creating your own import files.
        </p>
      </div>

      {/* ── Export card ── */}
      <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-6">
        <div className="flex items-center gap-2 mb-1">
          <Download size={15} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Export</h2>
        </div>
        <p className="text-xs text-text-muted mb-5">
          Choose what to include in the exported file, then download it.
        </p>

        <SectionSelector
          sections={ALL_SECTIONS}
          enabled={exportSections}
          onToggle={toggleExportSection}
          onToggleAll={toggleAllExport}
        />

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleExport}
            loading={exporting}
            disabled={exportSections.size === 0}
          >
            <Download size={14} className="mr-1.5" />
            Download JSON
          </Button>
        </div>
      </div>

      {/* ── Import card ── */}
      <div className="rounded-xl border border-border bg-bg-secondary p-6">
        <div className="flex items-center gap-2 mb-1">
          <Upload size={15} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Import</h2>
        </div>
        <p className="text-xs text-text-muted mb-5">
          Upload an Obliview export file. Select which sections to import and how to handle
          records whose UUID already exists in your database.
        </p>

        {/* File drop zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          className={[
            'mb-5 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed',
            'px-6 py-6 transition-colors',
            importFile
              ? 'border-accent/50 bg-accent/5'
              : 'border-border bg-bg-tertiary hover:border-accent hover:bg-accent/5',
          ].join(' ')}
        >
          <FileJson size={28} className={importFile ? 'text-accent' : 'text-text-muted'} />
          <span className="text-sm text-text-secondary text-center">
            {importFile ? importFile.name : 'Click to choose an export file (.json)'}
          </span>
          {importFile && (
            <span className="text-xs text-text-muted">
              {(importFile.size / 1024).toFixed(1)} KB
              {availableSections.length > 0 && (
                <> · {availableSections.length} section{availableSections.length !== 1 ? 's' : ''} found</>
              )}
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Options shown only once a file is loaded */}
        {importData && availableSections.length > 0 && (
          <>
            {/* Section selector */}
            <div className="mb-5">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                Sections to import
              </p>
              <SectionSelector
                sections={availableSections}
                enabled={importSections}
                onToggle={toggleImportSection}
                onToggleAll={toggleAllImport}
              />
            </div>

            {/* Conflict strategy */}
            <div className="mb-5">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                When a UUID already exists in the database
              </p>
              <div className="space-y-2">
                {CONFLICT_OPTIONS.map(opt => (
                  <label
                    key={opt.value}
                    className={[
                      'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                      conflictStrategy === opt.value
                        ? 'border-accent bg-accent/5'
                        : 'border-border hover:border-accent/40',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="conflictStrategy"
                      value={opt.value}
                      checked={conflictStrategy === opt.value}
                      onChange={() => setConflictStrategy(opt.value)}
                      className="mt-0.5 accent-accent"
                    />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                      <div className="text-xs text-text-muted mt-0.5">{opt.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={handleImport}
                loading={importing}
                disabled={importSections.size === 0}
              >
                <Upload size={14} className="mr-1.5" />
                Import
              </Button>
            </div>
          </>
        )}

        {/* No sections found */}
        {importData && availableSections.length === 0 && (
          <p className="text-sm text-text-muted text-center py-4">
            No importable sections found in this file.
          </p>
        )}

        {/* Results summary */}
        {importResults && (
          <div className="mt-5 rounded-lg border border-border bg-bg-tertiary p-4">
            <div className="flex items-center gap-2 mb-3 text-green-400">
              <CheckCircle2 size={15} />
              <span className="text-sm font-medium">Import successful</span>
            </div>
            <div className="space-y-1.5">
              {Object.entries(importResults).map(([section, r]) => (
                <div key={section} className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">
                    {SECTION_LABELS[section as Section] ?? section}
                  </span>
                  <span className="text-text-muted tabular-nums">
                    <span className="text-green-400">{r.created} created</span>
                    {' · '}
                    <span className="text-blue-400">{r.updated} updated</span>
                    {r.skipped > 0 && (
                      <>{' · '}<span className="text-yellow-400">{r.skipped} skipped</span></>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
