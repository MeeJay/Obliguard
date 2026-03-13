import type { AppTheme } from '@obliview/shared';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

interface ThemePickerProps {
  value: AppTheme;
  onChange: (theme: AppTheme) => void;
}

interface ThemeOption {
  id: AppTheme;
  label: string;
  description: string;
  preview: {
    bg: string;
    card: string;
    border: string;
    accent: string;
    textPrimary: string;
    textMuted: string;
    dot: string;
  };
}

const THEMES: ThemeOption[] = [
  {
    id: 'modern',
    label: 'Modern UI',
    description: 'Interface sombre avec accent orange',
    preview: {
      bg:          '#0d0d0c',
      card:        '#151513',
      border:      '#373633',
      accent:      '#f59e0b',
      textPrimary: '#e5e3e0',
      textMuted:   '#6b6864',
      dot:         '#2ea043',
    },
  },
  {
    id: 'neon',
    label: 'Neon UI',
    description: 'Interface sombre profonde avec effets lumineux orange',
    preview: {
      bg:          '#07080a',
      card:        '#0d0e11',
      border:      '#323339',
      accent:      '#ffa514',
      textPrimary: '#f0eae2',
      textMuted:   '#6a5e4e',
      dot:         '#00c35f',
    },
  },
];

function MiniPreview({ theme }: { theme: ThemeOption }) {
  const p = theme.preview;
  return (
    <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" className="w-full h-full rounded-md">
      {/* Background */}
      <rect width="120" height="80" fill={p.bg} />

      {/* Sidebar */}
      <rect x="0" y="0" width="28" height="80" fill={p.card} />
      {/* Sidebar items */}
      <rect x="4" y="10" width="20" height="4" rx="2" fill={p.border} />
      <rect x="4" y="18" width="16" height="4" rx="2" fill={p.border} />
      {/* Active sidebar item */}
      <rect x="0" y="28" width="28" height="6" fill={p.accent} opacity="0.12" />
      <rect x="0" y="28" width="2" height="6" fill={p.accent} />
      <rect x="4" y="30" width="16" height="3" rx="1.5" fill={p.accent} opacity="0.9" />
      <rect x="4" y="38" width="18" height="4" rx="2" fill={p.border} />
      <rect x="4" y="46" width="14" height="4" rx="2" fill={p.border} />

      {/* Main content area */}
      {/* Card 1 */}
      <rect x="32" y="8" width="38" height="28" rx="3" fill={p.card} stroke={p.border} strokeWidth="0.75" />
      <circle cx="40" cy="17" r="3" fill={p.dot} />
      <rect x="46" y="15" width="16" height="3" rx="1.5" fill={p.textPrimary} opacity="0.8" />
      <rect x="46" y="21" width="10" height="2.5" rx="1.25" fill={p.textMuted} opacity="0.6" />
      <rect x="34" y="28" width="32" height="2" rx="1" fill={p.border} />

      {/* Card 2 */}
      <rect x="74" y="8" width="38" height="28" rx="3" fill={p.card} stroke={p.border} strokeWidth="0.75" />
      <circle cx="82" cy="17" r="3" fill={p.dot} />
      <rect x="88" y="15" width="16" height="3" rx="1.5" fill={p.textPrimary} opacity="0.8" />
      <rect x="88" y="21" width="12" height="2.5" rx="1.25" fill={p.textMuted} opacity="0.6" />
      <rect x="76" y="28" width="32" height="2" rx="1" fill={p.border} />

      {/* Bottom card */}
      <rect x="32" y="44" width="80" height="28" rx="3" fill={p.card} stroke={p.border} strokeWidth="0.75" />
      <rect x="36" y="50" width="24" height="2.5" rx="1.25" fill={p.textPrimary} opacity="0.7" />
      <rect x="36" y="55" width="48" height="2" rx="1" fill={p.border} />
      <rect x="36" y="59" width="36" height="2" rx="1" fill={p.border} />
      {/* Orange accent button */}
      <rect x="86" y="62" width="20" height="6" rx="2" fill={p.accent} />
    </svg>
  );
}

export function ThemePicker({ value, onChange }: ThemePickerProps) {
  const handleSelect = (theme: AppTheme) => {
    applyTheme(theme);
    onChange(theme);
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {THEMES.map((theme) => {
        const isSelected = value === theme.id;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => handleSelect(theme.id)}
            className={cn(
              'flex flex-col rounded-xl border-2 overflow-hidden text-left transition-all duration-150',
              isSelected
                ? 'border-accent shadow-lg shadow-accent/20'
                : 'border-border hover:border-accent/50',
            )}
          >
            {/* Mini preview */}
            <div className="aspect-[3/2] w-full">
              <MiniPreview theme={theme} />
            </div>

            {/* Label row */}
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 transition-colors',
              isSelected ? 'bg-accent/10' : 'bg-bg-secondary',
            )}>
              <div className={cn(
                'h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center shrink-0',
                isSelected ? 'border-accent' : 'border-border',
              )}>
                {isSelected && <div className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </div>
              <div className="min-w-0">
                <div className={cn(
                  'text-sm font-semibold leading-tight',
                  isSelected ? 'text-accent' : 'text-text-primary',
                )}>
                  {theme.label}
                </div>
                <div className="text-[11px] text-text-muted leading-tight mt-0.5 truncate">
                  {theme.description}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
