import { describe, it, expect } from 'vitest';
import { eventMatches, filterMatches } from './github-triggers.js';

describe('eventMatches', () => {
  it('matches a bare event name against any action', () => {
    expect(eventMatches('pull_request', 'opened', ['pull_request'])).toBe(true);
    expect(eventMatches('pull_request', 'closed', ['pull_request'])).toBe(true);
    expect(eventMatches('push', undefined, ['push'])).toBe(true);
  });

  it('matches event.action notation', () => {
    expect(eventMatches('pull_request', 'opened', ['pull_request.opened'])).toBe(true);
    expect(eventMatches('pull_request', 'closed', ['pull_request.opened'])).toBe(false);
  });

  it('rejects when event type does not match', () => {
    expect(eventMatches('issues', 'opened', ['pull_request'])).toBe(false);
    expect(eventMatches('issues', 'opened', ['pull_request.opened'])).toBe(false);
  });

  it('accepts either form when both are configured', () => {
    expect(eventMatches('pull_request', 'opened', ['push', 'pull_request.opened'])).toBe(true);
    expect(eventMatches('push', undefined, ['push', 'pull_request.opened'])).toBe(true);
  });
});

describe('filterMatches', () => {
  it('passes when no filter is set', () => {
    expect(filterMatches({}, 'push', { type: 'github', repos: [], events: [] })).toBe(true);
  });

  it('honours filter.actions on pull_request', () => {
    const config = { type: 'github' as const, repos: [], events: [], filter: { actions: ['opened', 'reopened'] } };
    expect(filterMatches({ action: 'opened' }, 'pull_request', config)).toBe(true);
    expect(filterMatches({ action: 'closed' }, 'pull_request', config)).toBe(false);
    expect(filterMatches({}, 'pull_request', config)).toBe(false);
  });

  it('honours filter.branch for push using refs/heads/X', () => {
    const config = { type: 'github' as const, repos: [], events: [], filter: { branch: 'main' } };
    expect(filterMatches({ ref: 'refs/heads/main' }, 'push', config)).toBe(true);
    expect(filterMatches({ ref: 'refs/heads/feat/x' }, 'push', config)).toBe(false);
  });

  it('honours filter.branch for pull_request using base.ref', () => {
    const config = { type: 'github' as const, repos: [], events: [], filter: { branch: ['main', 'develop'] } };
    expect(filterMatches({ pull_request: { base: { ref: 'develop' } } }, 'pull_request', config)).toBe(true);
    expect(filterMatches({ pull_request: { base: { ref: 'topic' } } }, 'pull_request', config)).toBe(false);
  });

  it('honours filter.labels (any overlap)', () => {
    const config = { type: 'github' as const, repos: [], events: [], filter: { labels: ['bug', 'urgent'] } };
    expect(filterMatches({ pull_request: { labels: [{ name: 'urgent' }] } }, 'pull_request', config)).toBe(true);
    expect(filterMatches({ pull_request: { labels: [{ name: 'docs' }] } }, 'pull_request', config)).toBe(false);
    expect(filterMatches({ pull_request: {} }, 'pull_request', config)).toBe(false);
  });
});
