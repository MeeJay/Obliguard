import { AppError, HTTP_ERROR_CODES } from '../middleware/errorHandler';

/**
 * Catalogue of the machine-readable error codes the API answers with
 * (`{ success: false, error, code, params? }`).
 *
 * A code is stable: the client translates it (`errors.<code>` in the locale
 * files, the server `error` text as fallback) and may branch on it, so a code
 * value is never renamed once shipped. New codes are UPPER_SNAKE; a few older
 * domain codes (lowerCamel) are kept as they are.
 *
 * Each entry carries the English template of the translation. `{{name}}`
 * placeholders are filled from the `params` of the error (see codedError);
 * the client falls back to the server text when a placeholder has no value.
 * The server `error` text itself stays free English (more detail allowed).
 */
export const ERROR_CATALOGUE = {
  // ── Generic HTTP mapping (middleware/errorHandler.ts, validate.ts) ───────
  VALIDATION: { code: HTTP_ERROR_CODES.VALIDATION, en: 'Validation failed' },
  INVALID_JSON: { code: HTTP_ERROR_CODES.INVALID_JSON, en: 'Malformed request' },
  PAYLOAD_TOO_LARGE: { code: HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE, en: 'Request too large' },
  BAD_REQUEST: { code: HTTP_ERROR_CODES.BAD_REQUEST, en: 'Bad request' },
  CONFLICT: { code: HTTP_ERROR_CODES.CONFLICT, en: 'This entry already exists' },
  REFERENCE_CONFLICT: { code: HTTP_ERROR_CODES.REFERENCE_CONFLICT, en: 'This entry is still in use' },
  INVALID_REFERENCE: { code: HTTP_ERROR_CODES.INVALID_REFERENCE, en: 'A referenced entry does not exist' },
  INVALID_INPUT: { code: HTTP_ERROR_CODES.INVALID_INPUT, en: 'Invalid input' },
  NOT_FOUND: { code: HTTP_ERROR_CODES.NOT_FOUND, en: 'Not found' },
  TIMEOUT: { code: HTTP_ERROR_CODES.TIMEOUT, en: 'The server is busy, try again' },
  INTERNAL: { code: HTTP_ERROR_CODES.INTERNAL, en: 'Internal server error' },

  // ── Generic field validation ──────────────────────────────────────────────
  FIELD_REQUIRED: { code: 'FIELD_REQUIRED', en: '{{field}} is required' },
  FIELD_STRING: { code: 'FIELD_STRING', en: '{{field}} must be text' },
  FIELD_TOO_LONG: { code: 'FIELD_TOO_LONG', en: '{{field}} must be at most {{max}} characters' },
  FIELD_BOOLEAN: { code: 'FIELD_BOOLEAN', en: '{{field}} must be true or false' },
  FIELD_BOOLEAN_OR_NULL: { code: 'FIELD_BOOLEAN_OR_NULL', en: '{{field}} must be true, false or empty' },
  FIELD_INTEGER: { code: 'FIELD_INTEGER', en: '{{field}} must be a whole number' },
  FIELD_INTEGER_RANGE: { code: 'FIELD_INTEGER_RANGE', en: '{{field}} must be a whole number between {{min}} and {{max}}' },
  FIELD_OBJECT: { code: 'FIELD_OBJECT', en: '{{field}} is invalid' },
  FIELD_ARRAY: { code: 'FIELD_ARRAY', en: '{{field}} must be a list' },
  FIELD_ONE_OF: { code: 'FIELD_ONE_OF', en: '{{field}} must be one of: {{options}}' },
  FIELD_UNKNOWN: { code: 'FIELD_UNKNOWN', en: 'Unknown field: {{field}}' },
  PORT_INVALID: { code: 'PORT_INVALID', en: 'The port must be a number between 1 and 65535' },

  // ── Scope / tenant ownership ──────────────────────────────────────────────
  SCOPE_INVALID: { code: 'SCOPE_INVALID', en: 'Invalid scope' },
  SCOPE_ID_REQUIRED: { code: 'SCOPE_ID_REQUIRED', en: 'Choose a group or an agent for this scope' },
  SCOPE_ID_INVALID: { code: 'SCOPE_ID_INVALID', en: 'Invalid group or agent' },
  FOREIGN_TENANT_READ_ONLY: { code: 'FOREIGN_TENANT_READ_ONLY', en: 'This item belongs to another tenant: read-only from the Default tenant' },
  TENANT_MEMBERSHIP_REQUIRED: { code: 'TENANT_MEMBERSHIP_REQUIRED', en: 'You are not a member of this tenant' },
  TENANT_NOT_FOUND: { code: 'TENANT_NOT_FOUND', en: 'Tenant not found' },
  NO_TENANT_SELECTED: { code: 'NO_TENANT_SELECTED', en: 'No tenant selected' },
  AGENT_NOT_FOUND: { code: 'AGENT_NOT_FOUND', en: 'Agent not found' },
  GROUP_NOT_FOUND: { code: 'GROUP_NOT_FOUND', en: 'Group not found' },

  // ── Bans ──────────────────────────────────────────────────────────────────
  BAN_IP_REQUIRED: { code: 'BAN_IP_REQUIRED', en: 'Enter an IP address' },
  BAN_SINGLE_IP_REQUIRED: { code: 'BAN_SINGLE_IP_REQUIRED', en: 'Enter a single IPv4 or IPv6 address' },
  BAN_CIDR_PREFIX_INVALID: { code: 'BAN_CIDR_PREFIX_INVALID', en: 'Invalid subnet prefix' },
  BAN_CIDR_PREFIX_TWICE: { code: 'BAN_CIDR_PREFIX_TWICE', en: 'Give the subnet prefix only once' },
  BAN_TARGET_INVALID: { code: 'BAN_TARGET_INVALID', en: 'Invalid IP address or subnet' },
  BAN_TARGET_CIDR_NOT_ALLOWED: { code: 'BAN_TARGET_CIDR_NOT_ALLOWED', en: 'Subnets are not accepted here: enter a single IP address' },
  BAN_TARGET_TOO_WIDE: { code: 'BAN_TARGET_TOO_WIDE', en: 'Subnet too broad: the widest bannable network is /{{prefix}} for IPv{{family}}' },
  BAN_TARGET_RESERVED: { code: 'BAN_TARGET_RESERVED', en: 'Reserved or protected address: it cannot be banned' },
  BAN_SCOPE_INVALID: { code: 'BAN_SCOPE_INVALID', en: 'Invalid ban scope' },
  BAN_GLOBAL_DEFAULT_TENANT_ONLY: { code: 'BAN_GLOBAL_DEFAULT_TENANT_ONLY', en: 'Global bans can only be created from the Default tenant' },
  BAN_DEFAULT_TENANT_SCOPE: { code: 'BAN_DEFAULT_TENANT_SCOPE', en: 'Bans created from the Default tenant are global: leave the scope empty, or choose a group or an agent' },
  BAN_EXPIRES_AT_INVALID: { code: 'BAN_EXPIRES_AT_INVALID', en: 'Invalid expiry date' },
  BAN_EXPIRES_AT_PAST: { code: 'BAN_EXPIRES_AT_PAST', en: 'The expiry date must be in the future' },
  IP_WHITELISTED: { code: 'IP_WHITELISTED', en: 'This IP is whitelisted' },
  IP_ALREADY_BANNED: { code: 'IP_ALREADY_BANNED', en: 'This IP is already banned' },
  IP_ALREADY_BANNED_GLOBALLY: { code: 'IP_ALREADY_BANNED_GLOBALLY', en: 'This IP is already banned globally' },
  BAN_LIFTED_FOR_TENANT: { code: 'BAN_LIFTED_FOR_TENANT', en: 'This IP is banned globally but lifted on your tenant: use Re-enable instead' },
  BAN_PROMOTE_DEFAULT_TENANT_ONLY: { code: 'BAN_PROMOTE_DEFAULT_TENANT_ONLY', en: 'Promote to global is only available from the Default tenant' },
  BAN_NOT_FOUND: { code: 'BAN_NOT_FOUND', en: 'Ban not found' },
  BAN_INACTIVE: { code: 'BAN_INACTIVE', en: 'This ban is no longer active' },
  BAN_ALREADY_GLOBAL: { code: 'BAN_ALREADY_GLOBAL', en: 'This ban is already global' },
  BAN_ALREADY_LIFTED_FOR_TENANT: { code: 'BAN_ALREADY_LIFTED_FOR_TENANT', en: 'This ban is already lifted on this tenant' },
  BAN_FOREIGN_TENANT: { code: 'BAN_FOREIGN_TENANT', en: 'This ban belongs to another tenant' },
  BAN_EXCLUDE_GLOBAL_ONLY: { code: 'BAN_EXCLUDE_GLOBAL_ONLY', en: 'Only global bans can be lifted for one tenant' },
  BAN_EXCLUSION_NOT_FOUND: { code: 'BAN_EXCLUSION_NOT_FOUND', en: 'This ban is not lifted on this tenant' },

  // ── Ban durations (ban policy) ────────────────────────────────────────────
  BAN_POLICY_INVALID: { code: 'BAN_POLICY_INVALID', en: 'Invalid ban policy' },
  BAN_POLICY_TTL_REQUIRED: { code: 'BAN_POLICY_TTL_REQUIRED', en: 'Choose the automatic ban duration (or permanent)' },
  BAN_TTL_NOT_INTEGER: { code: 'BAN_TTL_NOT_INTEGER', en: 'The ban duration must be a whole number of seconds, or permanent' },
  BAN_TTL_OUT_OF_RANGE: { code: 'BAN_TTL_OUT_OF_RANGE', en: 'The ban duration must be between {{min}} and {{max}} seconds, or permanent' },
  BAN_LADDER_NOT_ARRAY: { code: 'BAN_LADDER_NOT_ARRAY', en: 'Invalid repeat-offender steps' },
  BAN_LADDER_TOO_LONG: { code: 'BAN_LADDER_TOO_LONG', en: 'At most {{max}} repeat-offender steps' },
  BAN_LADDER_STEP_INVALID: { code: 'BAN_LADDER_STEP_INVALID', en: 'Repeat-offender step {{step}} is invalid' },
  BAN_LADDER_PRIOR_BANS_INVALID: { code: 'BAN_LADDER_PRIOR_BANS_INVALID', en: 'Step {{step}}: the number of prior bans must be a whole number between 1 and {{max}}' },
  BAN_LADDER_ORDER: { code: 'BAN_LADDER_ORDER', en: 'Repeat-offender steps must be in strictly ascending order of prior bans' },
  BAN_LADDER_TTL_REQUIRED: { code: 'BAN_LADDER_TTL_REQUIRED', en: 'Step {{step}}: choose a duration (or permanent)' },
  BAN_LADDER_TTL_DECREASING: { code: 'BAN_LADDER_TTL_DECREASING', en: 'Step {{step}} is shorter than the step before it: a repeat offence never gets a shorter ban' },

  // ── Whitelist ─────────────────────────────────────────────────────────────
  WHITELIST_SCOPE_INVALID: { code: 'WHITELIST_SCOPE_INVALID', en: 'Invalid whitelist scope' },
  WHITELIST_IP_INVALID: { code: 'WHITELIST_IP_INVALID', en: 'Enter an IP address or a CIDR range' },
  IP_FILTER_INVALID: { code: 'IP_FILTER_INVALID', en: 'Invalid IP filter' },
  WHITELIST_DUPLICATE: { code: 'WHITELIST_DUPLICATE', en: 'This address is already whitelisted in this scope' },
  WHITELIST_CREATE_FAILED: { code: 'WHITELIST_CREATE_FAILED', en: 'Failed to create the whitelist entry' },
  WHITELIST_ENTRY_NOT_FOUND: { code: 'WHITELIST_ENTRY_NOT_FOUND', en: 'Whitelist entry not found' },
  WHITELIST_GLOBAL_READ_ONLY: { code: 'WHITELIST_GLOBAL_READ_ONLY', en: 'A global whitelist entry can only be removed from the Default tenant' },

  // ── Network limiting (rate limit policies) ────────────────────────────────
  RATE_LIMIT_SCOPE_INVALID: { code: 'RATE_LIMIT_SCOPE_INVALID', en: 'Invalid rate limit scope' },
  RATE_LIMIT_TYPE_INVALID: { code: 'RATE_LIMIT_TYPE_INVALID', en: 'Invalid rate limit type' },
  RATE_LIMIT_MAX_VALUE_INVALID: { code: 'RATE_LIMIT_MAX_VALUE_INVALID', en: 'The limit must be a whole number between 1 and {{max}}' },
  RATE_LIMIT_ACTION_INVALID: { code: 'RATE_LIMIT_ACTION_INVALID', en: 'This action is not available for this limit type' },
  RATE_LIMIT_BAN_MULTIPLIER_INVALID: { code: 'RATE_LIMIT_BAN_MULTIPLIER_INVALID', en: 'The ban threshold multiplier must be a whole number between {{min}} and {{max}}' },
  RATE_LIMIT_BAN_TTL_INVALID: { code: 'RATE_LIMIT_BAN_TTL_INVALID', en: 'The ban duration must be a whole number of seconds between 1 and {{max}}' },
  RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY: { code: 'RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY', en: 'Global rate limit policies can only be created, edited or removed from the Default tenant' },
  RATE_LIMIT_POLICY_CREATE_FAILED: { code: 'RATE_LIMIT_POLICY_CREATE_FAILED', en: 'Failed to create the rate limit policy' },
  RATE_LIMIT_POLICY_NOT_FOUND: { code: 'RATE_LIMIT_POLICY_NOT_FOUND', en: 'Rate limit policy not found' },

  // ── Remote blocklists ─────────────────────────────────────────────────────
  BLOCKLIST_URL_REFUSED: { code: 'BLOCKLIST_URL_REFUSED', en: 'This URL is not allowed: use a public http(s) address' },

  // ── Settings / retention ──────────────────────────────────────────────────
  SETTING_UNKNOWN: { code: 'SETTING_UNKNOWN', en: 'Unknown setting: {{key}}' },
  SETTING_EXTERNAL: { code: 'SETTING_EXTERNAL', en: '{{key}} is managed by its own controls' },
  SETTING_LEVEL_INVALID: { code: 'SETTING_LEVEL_INVALID', en: '{{key}} cannot be set at the {{level}} level' },
  RETENTION_SETTINGS_EMPTY: { code: 'RETENTION_SETTINGS_EMPTY', en: 'No retention setting given' },
  SMTP_PASSWORD_TOO_LONG: { code: 'SMTP_PASSWORD_TOO_LONG', en: 'The SMTP password is too long to be stored encrypted' },

  // ── Service templates ─────────────────────────────────────────────────────
  SERVICE_TEMPLATE_NOT_FOUND: { code: 'SERVICE_TEMPLATE_NOT_FOUND', en: 'Service template not found' },
  SERVICE_TEMPLATE_ASSIGNMENT_NOT_FOUND: { code: 'SERVICE_TEMPLATE_ASSIGNMENT_NOT_FOUND', en: 'Service template assignment not found' },
  SERVICE_TEMPLATE_BUILTIN_REGEX: { code: 'SERVICE_TEMPLATE_BUILTIN_REGEX', en: 'A built-in template cannot have a custom regex' },
  SERVICE_TEMPLATE_BUILTIN_DELETE: { code: 'SERVICE_TEMPLATE_BUILTIN_DELETE', en: 'A built-in service template cannot be deleted' },

  // ── Agents ────────────────────────────────────────────────────────────────
  COMMAND_OUTSTANDING: { code: 'commandOutstanding', en: 'This command is already pending for this agent' },
  UNKNOWN_COMMAND: { code: 'unknownCommand', en: 'Unknown command type' },
  NOT_AN_AGENT: { code: 'notAnAgent', en: 'Commands are only available for agents' },
  NOT_APPROVED: { code: 'notApproved', en: 'Only approved agents can receive this command' },
  COMMAND_UNSUPPORTED: { code: 'commandUnsupported', en: 'This agent version cannot run this command: update the agent first' },
  ALREADY_CURRENT: { code: 'alreadyCurrent', en: 'The agent is already up to date' },
  NOT_UPDATABLE: { code: 'notUpdatable', en: 'Only approved agents that reported a version can be updated' },
  ROLLOUT_SCOPE_CHANGED: { code: 'rolloutScopeChanged', en: 'The operating tenant changed since the preview: review it again' },
  VERSION_UNAVAILABLE: { code: 'versionUnavailable', en: 'No agent version available on this server' },
  AGENT_UPDATE_REQUIRED: { code: 'agentUpdateRequired', en: 'This agent version does not support this feature: update the agent' },
  AGENT_KEY_NAME_REQUIRED: { code: 'AGENT_KEY_NAME_REQUIRED', en: 'Enter a name for the API key' },
  AGENT_KEY_NAME_TOO_LONG: { code: 'AGENT_KEY_NAME_TOO_LONG', en: 'The name is limited to {{max}} characters' },
  AGENT_KEY_GROUP_INVALID: { code: 'AGENT_KEY_GROUP_INVALID', en: 'Invalid default group' },
  AGENT_KEY_NOTHING_TO_UPDATE: { code: 'AGENT_KEY_NOTHING_TO_UPDATE', en: 'Nothing to update' },
  AGENT_KEY_NOT_FOUND: { code: 'AGENT_KEY_NOT_FOUND', en: 'API key not found' },

  // ── Tenants ───────────────────────────────────────────────────────────────
  TENANT_HAS_AGENTS: { code: 'TENANT_HAS_AGENTS', en: 'This workspace still has {{count}} agent(s). Uninstall them first.' },
  TENANT_CONFIRM_MISMATCH: { code: 'TENANT_CONFIRM_MISMATCH', en: 'Type the workspace name to confirm the deletion' },
  TENANT_SLUG_TAKEN: { code: 'tenantSlugTaken', en: 'A tenant with this slug already exists' },
  TENANT_CONFLICT: { code: 'tenantConflict', en: 'This tenant already exists' },
  DEFAULT_TENANT: { code: 'defaultTenant', en: 'The default tenant cannot be deleted' },

  // ── Users / teams / permission sets ───────────────────────────────────────
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', en: 'User not found' },
  USER_ID_INVALID: { code: 'USER_ID_INVALID', en: 'Invalid user' },
  USERNAME_TAKEN: { code: 'USERNAME_TAKEN', en: 'This username already exists' },
  LAST_TENANT_ADMIN: { code: 'LAST_TENANT_ADMIN', en: 'The last administrator of this tenant cannot be removed' },
  LAST_PLATFORM_ADMIN: { code: 'LAST_PLATFORM_ADMIN', en: 'The last active administrator cannot be removed' },
  ADMIN_PLATFORM_ONLY: { code: 'ADMIN_PLATFORM_ONLY', en: 'Only a platform administrator can do this for an administrator account' },
  USER_ROLE_PLATFORM_ONLY: { code: 'USER_ROLE_PLATFORM_ONLY', en: 'Only a platform administrator can change a user role' },
  CANNOT_DISABLE_SELF: { code: 'CANNOT_DISABLE_SELF', en: 'You cannot disable your own account' },
  CANNOT_DELETE_SELF: { code: 'CANNOT_DELETE_SELF', en: 'You cannot delete your own account' },
  CANNOT_CHANGE_OWN_ACCESS: { code: 'CANNOT_CHANGE_OWN_ACCESS', en: 'You cannot change your own tenant access' },
  SSO_USER_MANAGED: { code: 'SSO_USER_MANAGED', en: 'SSO accounts are managed in Obligate' },
  TENANT_ADMIN_GRANT_REQUIRES_ADMIN: { code: 'TENANT_ADMIN_GRANT_REQUIRES_ADMIN', en: 'Only a tenant administrator can grant the tenant administrator role' },
  TENANT_ADMIN_MANAGE_REQUIRES_ADMIN: { code: 'TENANT_ADMIN_MANAGE_REQUIRES_ADMIN', en: "Only an administrator of each of this user's tenants can manage a tenant administrator" },
  USER_MANAGE_FOREIGN_TENANT: { code: 'USER_MANAGE_FOREIGN_TENANT', en: 'This user also belongs to a tenant where you cannot manage users' },
  USER_HAS_MORE_PERMISSIONS: { code: 'USER_HAS_MORE_PERMISSIONS', en: 'This user has permissions you do not hold' },
  ROLE_EXCEEDS_OWN_PERMISSIONS: { code: 'ROLE_EXCEEDS_OWN_PERMISSIONS', en: 'You can only grant a role whose permissions you hold' },
  TENANT_ASSIGNMENTS_INVALID: { code: 'TENANT_ASSIGNMENTS_INVALID', en: 'Invalid tenant access list' },
  TENANT_ASSIGNMENT_DUPLICATE: { code: 'TENANT_ASSIGNMENT_DUPLICATE', en: 'A tenant appears twice in the access list' },
  TENANT_ACCESS_CURRENT_ONLY: { code: 'TENANT_ACCESS_CURRENT_ONLY', en: 'You can only change access to the current tenant' },
  INVALID_TENANT_ROLE: { code: 'invalidTenantRole', en: 'Unknown role: it must be a permission set' },
  TEAM_NOT_FOUND: { code: 'TEAM_NOT_FOUND', en: 'Team not found' },
  TEAM_SCOPE_OUTSIDE_TENANT: { code: 'TEAM_SCOPE_OUTSIDE_TENANT', en: 'A group or agent does not belong to the team tenant' },
  TEAM_USER_OUTSIDE_TENANT: { code: 'TEAM_USER_OUTSIDE_TENANT', en: 'A user is not a member of the team tenant' },
  PERMISSION_SET_NOT_FOUND: { code: 'PERMISSION_SET_NOT_FOUND', en: 'Permission set not found' },
  PERMISSION_SET_NAME_INVALID: { code: 'PERMISSION_SET_NAME_INVALID', en: 'The name must be 1 to {{max}} characters' },
  PERMISSION_SET_SLUG_INVALID: { code: 'PERMISSION_SET_SLUG_INVALID', en: 'The slug must be 1 to {{max}} lowercase letters, digits, "-" or "_"' },
  PERMISSION_SET_SLUG_RESERVED: { code: 'permissionSetSlugReserved', en: 'The slug {{slug}} is reserved' },
  PERMISSION_SET_SLUG_TAKEN: { code: 'permissionSetSlugTaken', en: 'A permission set with this slug already exists' },
  PERMISSION_SET_PROTECTED: { code: 'permissionSetProtected', en: 'Built-in permission sets cannot be renamed or deleted, and the admin set always holds every capability' },
  PERMISSION_SET_IN_USE: { code: 'permissionSetInUse', en: 'This permission set is the role of {{count}} tenant membership(s)' },
  UNKNOWN_CAPABILITY: { code: 'unknownCapability', en: 'Unknown capability: {{capability}}' },
} as const;

export type ErrorCodeName = keyof typeof ERROR_CATALOGUE;
export type ErrorCode = (typeof ERROR_CATALOGUE)[ErrorCodeName]['code'];

/** Code values by name: `ERROR_CODES.BAN_NOT_FOUND` -> 'BAN_NOT_FOUND'. */
export const ERROR_CODES = Object.freeze(
  Object.fromEntries(Object.entries(ERROR_CATALOGUE).map(([name, e]) => [name, e.code])),
) as { readonly [K in ErrorCodeName]: (typeof ERROR_CATALOGUE)[K]['code'] };

/** Values a translation placeholder can take (sent as `params`). */
export type ErrorParams = Record<string, string | number | boolean>;

/** AppError plus the placeholder values of its translation. */
export type CodedAppError = AppError & { code: ErrorCode; params?: ErrorParams };

/**
 * An AppError carrying a catalogue code and, when its template has
 * placeholders, their values. The status and the English `message` are the
 * caller's (a code never changes the HTTP status); `params` is echoed next to
 * `code` by the error handler so the client can fill the translation.
 */
export function codedError(status: number, code: ErrorCode, message: string, params?: ErrorParams): CodedAppError {
  const err = new AppError(status, message, code) as CodedAppError;
  if (params && Object.keys(params).length > 0) err.params = params;
  return err;
}

/** English template of a code (null for a code outside the catalogue). */
export function errorTemplate(code: string): string | null {
  for (const e of Object.values(ERROR_CATALOGUE)) if (e.code === code) return e.en;
  return null;
}
