import type { NotificationConfigField, NotificationEventFields } from '@obliview/shared';

export interface NotificationPayload extends NotificationEventFields {
  monitorName: string;
  monitorUrl?: string;
  oldStatus: string;
  newStatus: string;
  message?: string;
  timestamp: string;
  appName?: string;
  // Group notification fields
  groupName?: string;
  groupId?: number;
  downMonitors?: string[];
  isGroupNotification?: boolean;
}

export interface NotificationPlugin {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];

  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
  sendTest(config: Record<string, unknown>): Promise<void>;
}
