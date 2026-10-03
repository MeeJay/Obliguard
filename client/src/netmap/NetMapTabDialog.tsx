import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { NetMapTab } from './tabStore';

interface Props {
  open: boolean;
  /** Tab being edited; null = create a new one. */
  tab: NetMapTab | null;
  agents: { id: number; label: string }[];
  onClose: () => void;
  onSave: (data: { name: string; agentIds: number[] }) => void;
  onDelete: (id: string) => void;
}

/** Create / edit / delete a NetMap view (a named subset of agents). */
export function NetMapTabDialog({ open, tab, agents, onClose, onSave, onDelete }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [agentIds, setAgentIds] = useState<Set<number>>(new Set());

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(tab?.name ?? '');
    setAgentIds(new Set(tab?.agentIds ?? []));
  }, [open, tab]);

  const valid = name.trim() !== '' && agentIds.size > 0;

  const toggle = (id: number) => {
    setAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = () => {
    if (!valid) return;
    onSave({ name: name.trim(), agentIds: [...agentIds] });
  };

  const remove = async () => {
    if (!tab) return;
    const ok = await confirm({
      title: t('netmap.tabs.deleteTitle', { defaultValue: 'Delete view' }),
      message: t('netmap.tabs.deleteConfirm', { defaultValue: 'Delete the view "{{name}}"? The agents stay on the map.', name: tab.name }),
      danger: true,
    });
    if (ok) onDelete(tab.id);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={tab
        ? t('netmap.tabs.editTitle', { defaultValue: 'Edit view' })
        : t('netmap.tabs.newTitle', { defaultValue: 'New view' })}
      footer={(
        <div className="flex w-full items-center gap-2">
          {tab && (
            <Button variant="danger" size="sm" onClick={() => void remove()}>
              {t('common.delete', { defaultValue: 'Delete' })}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button size="sm" onClick={save} disabled={!valid}>
              {tab ? t('common.save', { defaultValue: 'Save' }) : t('common.create', { defaultValue: 'Create' })}
            </Button>
          </div>
        </div>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
        <Input
          label={t('netmap.tabs.name', { defaultValue: 'Name' })}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('netmap.tabs.namePlaceholder', { defaultValue: 'View name' })}
          maxLength={60}
          autoFocus
        />
        <div>
          <div className="mb-1.5 text-sm font-medium text-text-secondary">
            {t('netmap.tabs.agents', { defaultValue: 'Agents' })}
          </div>
          {agents.length === 0 ? (
            <p className="text-sm text-text-muted">{t('netmap.tabs.noAgents', { defaultValue: 'No agent on the map.' })}</p>
          ) : (
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-2">
              {agents.map(ag => (
                <label key={ag.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm text-text-secondary hover:text-text-primary">
                  <input
                    type="checkbox"
                    checked={agentIds.has(ag.id)}
                    onChange={() => toggle(ag.id)}
                    className="accent-accent"
                  />
                  <span className="truncate">{ag.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
