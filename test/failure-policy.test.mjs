import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/failure-policy.mjs';

const expected = (kind, blocksLuna, recoverable) => ({ kind, blocksLuna, recoverable });
const cases = [
  ['actual sanitized 64-token incomplete metadata', {httpStatus:200,responseStatus:'incomplete',incompleteReason:'max_output_tokens',errorType:'ModelBehaviorError',errorCategory:'possible_output_limit',errorCode:null,transportUsage:{outputTokens:64},maxOutputTokens:64}, expected('output_limit',false,true)],
  ['200-token cap incomplete metadata', {httpStatus:200,responseStatus:'incomplete',incompleteReason:'max_output_tokens',maxOutputTokens:200}, expected('output_limit',false,true)],
  ['SDK completed response mismatch', {httpStatus:200,responseStatus:'completed',errorType:'ModelBehaviorError'}, expected('model_output',false,true)],
  ['content filter must stay rejected', {httpStatus:200,responseStatus:'incomplete',incompleteReason:'content_filter',errorType:'ModelBehaviorError'}, expected('output_rejected',false,false)],
  ['content filter code', {errorCode:'content_filter'}, expected('output_rejected',false,false)],
  ['401 authentication', {httpStatus:401}, expected('luna_unavailable',true,false)],
  ['403 authorization', {httpStatus:403}, expected('luna_unavailable',true,false)],
  ['key missing', {status:'key_missing'}, expected('luna_unavailable',true,false)],
  ['local auth block', {status:'auth_blocked'}, expected('luna_unavailable',true,false)],
  ['missing model', {errorCode:'model_not_found'}, expected('luna_unavailable',true,false)],
  ['404 explicit missing model', {httpStatus:404,errorCode:'model_not_found'}, expected('luna_unavailable',true,false)],
  ['404 unspecified resource cannot prove unavailable model', {httpStatus:404}, expected('unknown',false,false)],
  ['quota differs from temporary 429', {httpStatus:429,errorCode:'insufficient_quota'}, expected('luna_unavailable',true,false)],
  ['billing blocked', {errorCode:'billing_not_active'}, expected('luna_unavailable',true,false)],
  ['billing category', {errorCategory:'billing'}, expected('luna_unavailable',true,false)],
  ['429 temporary rate limit', {httpStatus:429,errorCode:'rate_limit_exceeded'}, expected('rate_limited',false,true)],
  ['rate limit enum', {errorCategory:'rate_limit'}, expected('rate_limited',false,true)],
  ['400 invalid request', {httpStatus:400,errorCode:'invalid_request_error'}, expected('request_configuration',false,true)],
  ['500 service failure', {httpStatus:500}, expected('service_failure',false,true)],
  ['503 service failure', {httpStatus:503}, expected('service_failure',false,true)],
  ['connection error', {errorType:'APIConnectionError'}, expected('transport_failure',false,true)],
  ['connection timeout', {errorType:'APIConnectionTimeoutError'}, expected('transport_failure',false,true)],
  ['network timeout category', {errorCategory:'network_timeout'}, expected('transport_failure',false,true)],
  ['unclassified error', {errorType:'Error',errorCategory:'unclassified'}, expected('unknown',false,false)],
  ['possible limit without transport metadata is insufficient', {errorCategory:'possible_output_limit'}, expected('unknown',false,false)],
  ['persistent stop alone does not establish root cause', {status:'api_blocked'}, expected('unknown',false,false)],
  ['absent record', undefined, expected('unknown',false,false)],
  ['null record', null, expected('unknown',false,false)],
];
for (const [name, record, result] of cases) {
  test(name, () => assert.deepEqual(classifyFailure(record), result));
}

test('does not inspect raw message, reason, output, or key fields', () => {
  const record = {httpStatus:200,responseStatus:'incomplete',incompleteReason:'max_output_tokens'};
  for (const field of ['message','reason','output','apiKey','key','rawResponse','error']) {
    Object.defineProperty(record, field, {get() {throw new Error(`Forbidden field read: ${field}`);}});
  }
  assert.deepEqual(classifyFailure(record), expected('output_limit',false,true));
});

test('free text cannot change unknown metadata into authentication or output failure', () => {
  const record = {message:'401 model_not_found content_filter max_output_tokens',reason:'billing',output:'rate_limit'};
  assert.deepEqual(classifyFailure(record), expected('unknown',false,false));
});

test('classification does not mutate a frozen record or nested usage', () => {
  const usage=Object.freeze({outputTokens:64});
  const record=Object.freeze({httpStatus:200,responseStatus:'incomplete',incompleteReason:'max_output_tokens',transportUsage:usage});
  assert.deepEqual(classifyFailure(record), expected('output_limit',false,true));
  assert.equal(record.transportUsage, usage);
});
