/**
 * Classify sanitized Luna failure metadata without consulting free-text fields.
 * Supported fields: httpStatus, status, responseStatus, incompleteReason,
 * errorCode, errorType, errorCategory. Messages, reasons, output and keys are ignored.
 * Recoverable describes a diagnosed correction/backoff path, not permission to retry immediately.
 */
export function classifyFailure(record) {
  const data = record && typeof record === 'object' ? record : {};
  const http = Number.isInteger(data.httpStatus) ? data.httpStatus : null;
  const code = data.errorCode;
  const type = data.errorType;
  const category = data.errorCategory;
  const status = data.status;
  const responseStatus = data.responseStatus;
  const incompleteReason = data.incompleteReason;
  const result = (kind, blocksLuna, recoverable) => ({ kind, blocksLuna, recoverable });

  // Authentication, model availability and funding block this exact model.
  // A plain 404 is insufficient to identify model unavailability.
  if (http === 401 || http === 403 ||
      ['key_missing', 'keymissing', 'auth_blocked'].includes(status) ||
      ['key_missing', 'keymissing', 'invalid_api_key', 'authentication_error',
       'permission_denied', 'model_not_found', 'insufficient_quota',
       'billing', 'billing_error', 'billing_not_active', 'billing_hard_limit_reached'].includes(code) ||
      ['key_missing', 'keymissing', 'auth_blocked', 'model_not_found',
       'insufficient_quota', 'billing'].includes(category)) {
    return result('luna_unavailable', true, false);
  }
  // Rejected output stays visible and is never treated as a retry/bypass opportunity.
  if (incompleteReason === 'content_filter' || code === 'content_filter' || category === 'content_filter') {
    return result('output_rejected', false, false);
  }
  if (http === 200 && responseStatus === 'incomplete' && incompleteReason === 'max_output_tokens') {
    return result('output_limit', false, true);
  }
  if (http === 200 && type === 'ModelBehaviorError') {
    return result('model_output', false, true);
  }
  if (http === 429 || ['rate_limit', 'rate_limit_exceeded'].includes(code) || category === 'rate_limit') {
    return result('rate_limited', false, true);
  }
  if (http === 400 && !['model_not_found', 'content_filter'].includes(code)) {
    return result('request_configuration', false, true);
  }
  if (http !== null && http >= 500 && http <= 599) {
    return result('service_failure', false, true);
  }
  if (['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError'].includes(type) ||
      ['network_timeout', 'connection_error', 'timeout', 'etimedout', 'ECONNRESET', 'ETIMEDOUT'].includes(code) ||
      ['network_timeout', 'transport_failure', 'connection_error'].includes(category)) {
    return result('transport_failure', false, true);
  }
  return result('unknown', false, false);
}
