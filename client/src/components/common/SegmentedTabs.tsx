import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface SegmentedTab<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Small trailing element (count pill, dot…). */
  badge?: ReactNode;
  disabled?: boolean;
  /** Filtered out (convenient for permission-gated tabs). */
  hidden?: boolean;
}

export interface SegmentedTabsProps<T extends string = string> {
  tabs: ReadonlyArray<SegmentedTab<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Stretch tabs to share the width (default true). */
  fill?: boolean;
  /** md = px-4 py-2 text-sm (default) · sm = px-3 py-1.5 text-xs. */
  size?: 'sm' | 'md';
  /** Extra classes for the bar container. */
  className?: string;
  /** Extra classes for every tab button. */
  tabClassName?: string;
  /** Accessible name of the tablist. */
  ariaLabel?: string;
}

/**
 * The app's segmented tab bar (borderless bg-bg-secondary pill container,
 * accent active tab), mirrored from Obliance. When the tabs do not fit they
 * scroll horizontally (snap, hidden scrollbar) instead of overflowing, and
 * the active tab is kept in view. Arrow keys / Home / End move between the
 * enabled tabs (roving tabindex).
 *
 *   <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} />
 */
export function SegmentedTabs<T extends string = string>({
  tabs,
  value,
  onChange,
  fill = true,
  size = 'md',
  className,
  tabClassName,
  ariaLabel,
}: SegmentedTabsProps<T>) {
  const barRef = useRef<HTMLDivElement>(null);
  const visible = tabs.filter((tab) => !tab.hidden);
  // Roving tabindex: the selected tab is the Tab stop; when the value is not
  // among the visible tabs, the first enabled one is, so the bar stays reachable.
  const focusId = visible.some((tab) => tab.id === value)
    ? value
    : visible.find((tab) => !tab.disabled)?.id;

  // Keep the active tab visible when the bar scrolls (horizontal only — never
  // scrollIntoView, which would also scroll the page vertically).
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || bar.scrollWidth <= bar.clientWidth) return;
    const active = bar.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    // The bar is `relative`, so it is the tabs' offsetParent.
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    else if (right > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: right - bar.clientWidth + 8, behavior: 'smooth' });
    }
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const enabled = visible.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const idx = enabled.findIndex((tab) => tab.id === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else next = enabled.length - 1;
    e.preventDefault();
    onChange(enabled[next].id);
    requestAnimationFrame(() => {
      barRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  };

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        // No border (Obli borderless look): the 5px padding keeps the exact
        // geometry of a 1px transparent border + p-1, which the neon theme
        // would otherwise paint visible (`.bg-bg-secondary` border colour).
        'relative flex items-center gap-1 rounded-lg bg-bg-secondary p-[5px]',
        'overflow-x-auto overscroll-x-contain scrollbar-none snap-x',
        className,
      )}
    >
      {visible.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={tab.id === focusId ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex shrink-0 snap-start items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors',
              size === 'md' ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs',
              fill && 'flex-1',
              selected ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
              tabClassName,
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}
