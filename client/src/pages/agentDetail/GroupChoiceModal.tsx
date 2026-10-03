import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { GroupPicker } from '@/components/common/GroupPicker';
import { Modal } from '@/components/common/Modal';
import { useGroupStore } from '@/store/groupStore';

/**
 * Pick the agent group for an approval (optional group) or a move. The
 * confirm button runs `onConfirm`; the modal closes when it resolves true.
 * Choosing a group needs agents.manage (canPickGroup): without it an approval
 * is confirmed without a group (onConfirm(undefined)), so an approver-only
 * user is not refused with 403.
 */
export function GroupChoiceModal({
  mode,
  hostname,
  initialGroupId,
  busy,
  canPickGroup = true,
  onConfirm,
  onClose,
}: {
  mode: 'approve' | 'move';
  hostname: string;
  initialGroupId: number | null;
  busy: boolean;
  /** agents.manage: the group picker is shown (always true for a move). */
  canPickGroup?: boolean;
  onConfirm: (groupId: number | null | undefined) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);

  useEffect(() => {
    if (tree.length === 0) void fetchTree();
  }, [tree.length, fetchTree]);

  const approve = mode === 'approve';
  const pickGroup = !approve || canPickGroup;
  const unchanged = !approve && groupId === initialGroupId;

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={approve
        ? t('agentDetail.lifecycle.approveTitle', { defaultValue: 'Approve agent' })
        : t('agentDetail.lifecycle.moveTitle', { defaultValue: 'Move to another group' })}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button
            type="button"
            loading={busy}
            disabled={unchanged}
            onClick={async () => { if (await onConfirm(pickGroup ? groupId : undefined)) onClose(); }}
          >
            {approve
              ? t('agentDetail.lifecycle.approve', { defaultValue: 'Approve' })
              : t('agentDetail.lifecycle.move', { defaultValue: 'Move' })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {approve && !pickGroup
            ? t('agentDetail.lifecycle.approveDescNoGroup', {
              defaultValue: 'Approve {{hostname}}: it starts receiving its configuration and enforcing bans. It keeps its current group (or the default group of its enrollment key).',
              hostname,
            })
            : approve
            ? t('agentDetail.lifecycle.approveDesc', {
              defaultValue: 'Approve {{hostname}}: it starts receiving its configuration and enforcing bans. Choose its group (optional).',
              hostname,
            })
            : t('agentDetail.lifecycle.moveDesc', {
              defaultValue: 'Move {{hostname}} to another group. Group settings, templates and policies then apply to it.',
              hostname,
            })}
        </p>
        {pickGroup && (
          <div className="space-y-1">
            <span className="block text-sm font-medium text-text-secondary">
              {t('agentDetail.lifecycle.group', { defaultValue: 'Agent group' })}
            </span>
            <GroupPicker
              value={groupId}
              onChange={setGroupId}
              tree={tree}
              kindFilter="agent"
              placeholder={t('agents.noGroup', '— No group —')}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
