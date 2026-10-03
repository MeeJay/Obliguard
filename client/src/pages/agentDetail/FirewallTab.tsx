import { useTranslation } from 'react-i18next';
import { FirewallPanel } from '@/components/agent/FirewallPanel';
import { useCan } from '@/hooks/usePermission';
import { NetworkLimitsPanel } from '@/pages/RateLimitPage';
import { type AgentTabProps } from './parts';

/**
 * Firewall: the host firewall rules (read live over the agent channel;
 * writes need firewall.rules.write) and the network limits of this agent
 * (rate limiting and traffic shaping; NetworkLimitsPanel gates its own writes
 * on rate_limit.write).
 */
export function FirewallTab({ device, readOnly, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const canReadRules = useCan('firewall.rules.read');
  const canWriteRules = useCan('firewall.rules.write');
  return (
    <div className="space-y-6">
      {/* Host rules are read over the Go agent's channel (not MikroTik / M365 sources). */}
      {device.deviceType === 'agent' && canReadRules && (
        <FirewallPanel
          key={`fw-${refreshKey}`}
          deviceId={device.id}
          wsConnected={device.wsConnected ?? false}
          readOnly={readOnly || !canWriteRules}
        />
      )}
      <NetworkLimitsPanel
        key={`nl-${refreshKey}`}
        scope="agent"
        scopeId={device.id}
        label={device.name || device.hostname}
        title={t('agentDetail.firewall.networkLimits', { defaultValue: 'Network limits (rate & traffic shaping)' })}
        readOnly={readOnly}
      />
    </div>
  );
}
