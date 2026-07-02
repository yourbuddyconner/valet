#!/usr/bin/env node

const HARVEST_BASE_URL = 'https://harvest.greenhouse.io';
const OAUTH_TOKEN_URL = 'https://auth.greenhouse.io/token';
const TRANSITION_TOKEN_URL = `${HARVEST_BASE_URL}/auth/token`;

const DEFAULT_CHECKS = ['jobs', 'openings', 'departments', 'offices', 'job_posts'];
const OPTIONAL_CHECKS = {
  applications: 'applications',
  interviews: 'scheduled_interviews',
};

const V3_ENDPOINTS = {
  jobs: { label: 'Jobs', path: '/v3/jobs' },
  openings: { label: 'Openings', path: '/v3/openings' },
  departments: { label: 'Departments', path: '/v3/departments' },
  offices: { label: 'Offices', path: '/v3/offices' },
  job_posts: { label: 'Job posts', path: '/v3/job_posts' },
  applications: { label: 'Applications', path: '/v3/applications', sensitive: true },
  scheduled_interviews: {
    label: 'Scheduled interviews',
    path: '/v3/scheduled_interviews',
    sensitive: true,
  },
};

const SAFE_FIELDS = {
  jobs: [
    'id',
    'name',
    'status',
    'requisition_id',
    'confidential',
    'department_id',
    'office_id',
    'office_ids',
    'created_at',
    'updated_at',
    'opened_at',
    'closed_at',
  ],
  openings: [
    'id',
    'job_id',
    'opening_id',
    'open',
    'status',
    'opened_at',
    'closed_at',
    'close_reason_id',
    'application_id',
  ],
  departments: ['id', 'name', 'parent_id'],
  offices: ['id', 'name', 'location', 'parent_id'],
  job_posts: ['id', 'job_id', 'title', 'active', 'live', 'internal', 'external', 'created_at', 'updated_at'],
  applications: ['id', 'job_id', 'status', 'stage_id', 'created_at', 'updated_at', 'rejected_at'],
  scheduled_interviews: [
    'id',
    'application_id',
    'job_id',
    'stage_id',
    'status',
    'starts_at',
    'ends_at',
    'created_at',
    'updated_at',
  ],
};

export function parseArgs(argv) {
  const options = {
    checks: [...DEFAULT_CHECKS],
    json: false,
    limit: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--include-applications') {
      pushUnique(options.checks, OPTIONAL_CHECKS.applications);
      continue;
    }

    if (arg === '--include-interviews') {
      pushUnique(options.checks, OPTIONAL_CHECKS.interviews);
      continue;
    }

    if (arg === '--limit') {
      const value = Number.parseInt(readValue(argv, index, arg), 10);
      if (!Number.isInteger(value) || value < 1 || value > 25) {
        throw new Error('--limit must be an integer from 1 to 25');
      }
      options.limit = value;
      index += 1;
      continue;
    }

    if (arg === '--checks') {
      const checks = readValue(argv, index, arg)
        .split(',')
        .map((check) => check.trim())
        .filter(Boolean);
      validateChecks(checks);
      options.checks = checks;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function buildEndpointUrl({ baseUrl = HARVEST_BASE_URL, path, limit }) {
  const url = new URL(path, baseUrl);
  url.searchParams.set('per_page', String(limit));
  return url.toString();
}

export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="?next"?$/);
    if (match) return match[1];
  }

  return null;
}

export function resolveAuthPlan(env) {
  if (env.GREENHOUSE_ACCESS_TOKEN) {
    return { kind: 'bearer', accessToken: env.GREENHOUSE_ACCESS_TOKEN };
  }

  if (env.GREENHOUSE_CLIENT_ID && env.GREENHOUSE_CLIENT_SECRET) {
    return {
      kind: 'oauth-client',
      clientId: env.GREENHOUSE_CLIENT_ID,
      clientSecret: env.GREENHOUSE_CLIENT_SECRET,
      sub: env.GREENHOUSE_USER_ID,
      tokenUrl: OAUTH_TOKEN_URL,
    };
  }

  if (env.GREENHOUSE_API_KEY) {
    return {
      kind: 'v3-transition',
      apiKey: env.GREENHOUSE_API_KEY,
      tokenUrl: TRANSITION_TOKEN_URL,
    };
  }

  throw new Error(
    'Set GREENHOUSE_CLIENT_ID/GREENHOUSE_CLIENT_SECRET, GREENHOUSE_ACCESS_TOKEN, or GREENHOUSE_API_KEY',
  );
}

export function redactForDisplay(check, item) {
  const fields = SAFE_FIELDS[check] ?? ['id', 'name', 'status'];
  const redacted = {};

  for (const field of fields) {
    if (Object.hasOwn(item, field)) {
      redacted[field] = item[field];
    }
  }

  return redacted;
}

async function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    console.error('');
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const result = await runApiSmoke(options, process.env, fetch);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  printResult(result);
  process.exitCode = result.ok ? 0 : 1;
}

async function runApiSmoke(options, env, fetchImpl) {
  const result = {
    api: 'v3',
    ok: false,
    auth: null,
    checks: [],
    error: null,
  };

  let authPlan;
  try {
    authPlan = resolveAuthPlan(env);
    result.auth = describeAuthPlan(authPlan);
  } catch (error) {
    result.error = error.message;
    return result;
  }

  let authorization;
  try {
    authorization = await getAuthorizationHeader(authPlan, fetchImpl);
  } catch (error) {
    result.error = error.message;
    return result;
  }

  for (const check of options.checks) {
    const endpoint = V3_ENDPOINTS[check];
    if (!endpoint) {
      result.checks.push({
        name: check,
        ok: false,
        skipped: true,
        reason: `${check} does not have a v3 list endpoint in this smoke script`,
      });
      continue;
    }

    result.checks.push(
      await runReadCheck({
        authorization,
        check,
        endpoint,
        fetchImpl,
        limit: options.limit,
      }),
    );
  }

  result.ok = result.checks.length > 0 && result.checks.every((check) => check.ok || check.skipped);
  return result;
}

async function getAuthorizationHeader(authPlan, fetchImpl) {
  if (authPlan.kind === 'bearer') {
    return `Bearer ${authPlan.accessToken}`;
  }

  if (authPlan.kind === 'v3-transition') {
    const response = await fetchImpl(authPlan.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthorization(authPlan.apiKey),
        Accept: 'application/json',
      },
    });
    const body = await readResponseBody(response);

    if (!response.ok) {
      throw new Error(formatHttpError('Could not generate v3 transition token', response, body));
    }

    if (!body.json?.access_token) {
      throw new Error('Token response did not include access_token');
    }

    return `Bearer ${body.json.access_token}`;
  }

  if (authPlan.kind === 'oauth-client') {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (authPlan.sub) form.set('sub', authPlan.sub);

    const response = await fetchImpl(authPlan.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthorization(`${authPlan.clientId}:${authPlan.clientSecret}`, false),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const body = await readResponseBody(response);

    if (!response.ok) {
      throw new Error(formatHttpError('Could not generate OAuth access token', response, body));
    }

    if (!body.json?.access_token) {
      throw new Error('Token response did not include access_token');
    }

    return `Bearer ${body.json.access_token}`;
  }

  throw new Error(`Unsupported auth plan: ${authPlan.kind}`);
}

async function runReadCheck({ authorization, check, endpoint, fetchImpl, limit }) {
  const url = buildEndpointUrl({ path: endpoint.path, limit });

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
      },
    });
    const body = await readResponseBody(response);
    const items = Array.isArray(body.json) ? body.json : [];

    if (!response.ok) {
      return {
        name: check,
        label: endpoint.label,
        ok: false,
        sensitive: Boolean(endpoint.sensitive),
        status: response.status,
        url,
        rateLimit: readRateLimit(response.headers),
        error: formatResponseMessage(body),
      };
    }

    return {
      name: check,
      label: endpoint.label,
      ok: true,
      sensitive: Boolean(endpoint.sensitive),
      status: response.status,
      url,
      count: items.length,
      hasNextPage: Boolean(parseNextLink(response.headers.get('link'))),
      rateLimit: readRateLimit(response.headers),
      sample: items.slice(0, Math.min(3, items.length)).map((item) => redactForDisplay(check, item)),
    };
  } catch (error) {
    return {
      name: check,
      label: endpoint.label,
      ok: false,
      sensitive: Boolean(endpoint.sensitive),
      url,
      error: error.message,
    };
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return { text: '', json: null };

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function basicAuthorization(value, appendBlankPassword = true) {
  const credential = appendBlankPassword ? `${value}:` : value;
  return `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

function formatHttpError(prefix, response, body) {
  const message = formatResponseMessage(body);
  const retryAfter = response.headers.get('retry-after');
  const retry = retryAfter ? ` Retry after ${retryAfter}s.` : '';
  return `${prefix}: HTTP ${response.status}${message ? ` - ${message}` : ''}.${retry}`;
}

function formatResponseMessage(body) {
  if (body.json && typeof body.json === 'object') {
    const parts = [];
    if (typeof body.json.message === 'string') parts.push(body.json.message);
    if (Array.isArray(body.json.errors)) {
      parts.push(
        body.json.errors
          .map((error) => {
            if (typeof error === 'string') return error;
            if (error && typeof error === 'object') return JSON.stringify(error);
            return String(error);
          })
          .join('; '),
      );
    }
    if (parts.length > 0) return parts.join(' - ');
  }

  return body.text.slice(0, 240);
}

function readRateLimit(headers) {
  return {
    limit: headers.get('x-ratelimit-limit'),
    remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'),
    retryAfter: headers.get('retry-after'),
  };
}

function describeAuthPlan(authPlan) {
  if (authPlan.kind === 'bearer') return 'Harvest v3 Bearer auth with GREENHOUSE_ACCESS_TOKEN';
  if (authPlan.kind === 'oauth-client') {
    return authPlan.sub
      ? 'Harvest v3 OAuth client credentials with GREENHOUSE_USER_ID'
      : 'Harvest v3 OAuth client credentials';
  }
  return 'Harvest v3 transition token minted from GREENHOUSE_API_KEY';
}

function printResult(result) {
  console.log(`Greenhouse Harvest ${result.api} read smoke test`);
  console.log('No data writes are performed. Token generation may use POST only for auth.');

  if (result.auth) console.log(`Auth: ${result.auth}`);

  if (result.error) {
    console.log(`Auth/setup failed: ${result.error}`);
    console.log('');
    return;
  }

  for (const check of result.checks) {
    if (check.skipped) {
      console.log(`- ${check.name}: skipped (${check.reason})`);
      continue;
    }

    if (!check.ok) {
      const rate = formatRateLimit(check.rateLimit);
      console.log(`- ${check.label}: FAIL HTTP ${check.status ?? 'n/a'}${rate}`);
      if (check.error) console.log(`  ${check.error}`);
      continue;
    }

    const rate = formatRateLimit(check.rateLimit);
    const paging = check.hasNextPage ? ', next page available' : '';
    console.log(`- ${check.label}: OK ${check.count} item(s)${paging}${rate}`);
    if (check.sensitive) {
      console.log('  Sensitive endpoint: displaying IDs/status fields only.');
    }
    for (const sample of check.sample) {
      console.log(`  ${JSON.stringify(sample)}`);
    }
  }

  console.log('');
}

function formatRateLimit(rateLimit) {
  if (!rateLimit) return '';
  const parts = [];
  if (rateLimit.remaining !== null) parts.push(`remaining ${rateLimit.remaining}`);
  if (rateLimit.limit !== null) parts.push(`limit ${rateLimit.limit}`);
  if (rateLimit.retryAfter !== null) parts.push(`retry-after ${rateLimit.retryAfter}s`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function printUsage() {
  console.log(`Usage:
  GREENHOUSE_API_KEY=... node scripts/test-greenhouse.mjs
  GREENHOUSE_API_KEY=... node scripts/test-greenhouse.mjs --limit 3
  GREENHOUSE_ACCESS_TOKEN=... node scripts/test-greenhouse.mjs --json
  GREENHOUSE_CLIENT_ID=... GREENHOUSE_CLIENT_SECRET=... node scripts/test-greenhouse.mjs

Environment:
  GREENHOUSE_API_KEY                         Single Harvest API key. Exchanged for a v3 transition token.
  GREENHOUSE_ACCESS_TOKEN                    Existing Harvest v3 Bearer token.
  GREENHOUSE_CLIENT_ID / GREENHOUSE_CLIENT_SECRET
                                             Harvest v3 OAuth client credentials.
  GREENHOUSE_USER_ID                         Optional user id for OAuth client credentials sub.

Options:
  --limit N                                  Items to request per endpoint, 1-25. Default: 5.
  --checks a,b,c                             Override checks. Known checks: ${knownChecks().join(', ')}.
  --include-applications                     Also test applications with redacted output.
  --include-interviews                       Also test scheduled interviews with redacted output.
  --json                                     Print machine-readable JSON.
  --help                                     Show this message.

Default checks are read-only and avoid candidate profiles, scorecards, offers, EEOC,
demographics, activity feeds, and all write endpoints.`);
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function pushUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function validateChecks(checks) {
  const known = new Set(knownChecks());
  for (const check of checks) {
    if (!known.has(check)) {
      throw new Error(`Unknown check "${check}". Known checks: ${knownChecks().join(', ')}`);
    }
  }
}

function knownChecks() {
  return Object.keys(V3_ENDPOINTS).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
