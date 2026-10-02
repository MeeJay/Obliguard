// Server → Client events
export const SOCKET_EVENTS = {
  // Connection
  INITIAL_DATA: 'initialData',

  // Group events
  GROUP_CREATED: 'group:created',
  GROUP_UPDATED: 'group:updated',
  GROUP_DELETED: 'group:deleted',
  GROUP_MOVED: 'group:moved',

  // Notification events
  NOTIFICATION_SENT: 'notification:sent',

  // Settings events
  SETTINGS_UPDATED: 'settings:updated',

  // Agent device events
  AGENT_DEVICE_UPDATED: 'agent:deviceUpdated',
  /** Real-time UP/DOWN/UPDATING status (AgentLiveStatus) from the agent hub */
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  /** Emitted when a device is auto-deleted (e.g. after successful uninstall command) */
  AGENT_DEVICE_DELETED: 'agent:deviceDeleted',
  /** New pending enrolment (payload AgentDeviceCreatedEvent), tenant admins only */
  AGENT_DEVICE_CREATED: 'agent:deviceCreated',

  // Live alert / notification events
  /** Emitted to tenant:{tenantId}:notifications when a new DB-backed alert is created */
  NOTIFICATION_NEW: 'notification:new',
} as const;
