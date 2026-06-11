import { Eye } from 'lucide-react';

/**
 * Banner shown on every agent that is in evaluate-only (dry-run) mode — whether
 * set directly on the agent or inherited from an ancestor group. Makes the mode
 * visible at a glance: events are observed but no bans are created or enforced.
 */
export function EvaluateOnlyBanner({ source }: { source?: 'agent' | 'group' | null }) {
  return (
    <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5 text-sm">
      <Eye size={16} className="text-amber-500 shrink-0" />
      <span className="text-text-primary flex-1">
        <span className="font-semibold text-amber-500">Evaluate-only mode</span>
        {' — events are observed but no bans are created or enforced. '}
        Tune your whitelist, then turn it off to start enforcing.
        {source === 'group' && (
          <span className="text-text-secondary"> (inherited from group)</span>
        )}
      </span>
    </div>
  );
}
