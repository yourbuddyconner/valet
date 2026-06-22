import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEndpointUrl,
  parseArgs,
  parseNextLink,
  redactForDisplay,
  resolveAuthPlan,
} from './test-greenhouse.mjs';

test('parseArgs defaults to v3 read-only checks', () => {
  const options = parseArgs([]);

  assert.equal(options.limit, 5);
  assert.deepEqual(options.checks, ['jobs', 'openings', 'departments', 'offices', 'job_posts']);
});

test('parseArgs rejects legacy API version flags', () => {
  assert.throws(() => parseArgs(['--api', 'both']), /Unknown argument: --api/);
});

test('parseArgs adds applications only when explicitly requested', () => {
  const options = parseArgs(['--include-applications', '--limit', '3']);

  assert.equal(options.limit, 3);
  assert.deepEqual(options.checks, [
    'jobs',
    'openings',
    'departments',
    'offices',
    'job_posts',
    'applications',
  ]);
});

test('buildEndpointUrl keeps v3 pagination params on the first request only', () => {
  const url = buildEndpointUrl({
    baseUrl: 'https://harvest.greenhouse.io',
    path: '/v3/jobs',
    limit: 7,
  });

  assert.equal(url, 'https://harvest.greenhouse.io/v3/jobs?per_page=7');
});

test('parseNextLink reads the next relation from a Link header', () => {
  const link =
    '<https://harvest.greenhouse.io/v3/jobs?cursor=abc>; rel="next", <https://example.test/last>; rel="last"';

  assert.equal(parseNextLink(link), 'https://harvest.greenhouse.io/v3/jobs?cursor=abc');
  assert.equal(parseNextLink(null), null);
});

test('resolveAuthPlan prefers v3 transition tokens for Harvest API keys', () => {
  const plan = resolveAuthPlan({ GREENHOUSE_API_KEY: 'gh-key' });

  assert.equal(plan.kind, 'v3-transition');
  assert.equal(plan.tokenUrl, 'https://harvest.greenhouse.io/auth/token');
});

test('resolveAuthPlan supports direct v3 access tokens', () => {
  assert.deepEqual(resolveAuthPlan({ GREENHOUSE_ACCESS_TOKEN: 'token' }), {
    kind: 'bearer',
    accessToken: 'token',
  });
});

test('resolveAuthPlan supports v3 OAuth client credentials', () => {
  assert.deepEqual(
    resolveAuthPlan({
      GREENHOUSE_CLIENT_ID: 'client-id',
      GREENHOUSE_CLIENT_SECRET: 'client-secret',
      GREENHOUSE_USER_ID: '123',
    }),
    {
      kind: 'oauth-client',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      sub: '123',
      tokenUrl: 'https://auth.greenhouse.io/token',
    },
  );
});

test('resolveAuthPlan fails without v3 credentials', () => {
  assert.throws(() => resolveAuthPlan({}), {
    message:
      'Set GREENHOUSE_CLIENT_ID/GREENHOUSE_CLIENT_SECRET, GREENHOUSE_ACCESS_TOKEN, or GREENHOUSE_API_KEY',
  });
});

test('redactForDisplay only keeps non-sensitive summary fields', () => {
  const redacted = redactForDisplay('applications', {
    id: 123,
    candidate_id: 456,
    job_id: 789,
    status: 'active',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email_addresses: [{ value: 'ada@example.com' }],
    custom_fields: { salary: '$100k' },
    keyed_custom_fields: { salary: { value: '$100k' } },
  });

  assert.deepEqual(redacted, {
    id: 123,
    job_id: 789,
    status: 'active',
  });
});
