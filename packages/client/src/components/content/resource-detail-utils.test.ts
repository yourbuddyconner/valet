import { describe, expect, it } from 'vitest';
import { canEditPersona, canEditSkill, getOwnerDisplayName } from './resource-detail-utils';

describe('resource detail permissions', () => {
  it('lets only managed skill owners edit skills', () => {
    expect(canEditSkill({ source: 'managed', ownerId: 'user-1' }, { id: 'user-1', role: 'member' })).toBe(true);
    expect(canEditSkill({ source: 'managed', ownerId: 'user-2' }, { id: 'user-1', role: 'admin' })).toBe(false);
    expect(canEditSkill({ source: 'builtin', ownerId: 'user-1' }, { id: 'user-1', role: 'member' })).toBe(false);
  });

  it('lets persona creators and admins edit personas', () => {
    expect(canEditPersona({ createdBy: 'user-1' }, { id: 'user-1', role: 'member' })).toBe(true);
    expect(canEditPersona({ createdBy: 'user-2' }, { id: 'user-1', role: 'admin' })).toBe(true);
    expect(canEditPersona({ createdBy: 'user-2' }, { id: 'user-1', role: 'member' })).toBe(false);
  });
});

describe('getOwnerDisplayName', () => {
  it('prefers name, then email, then a neutral fallback', () => {
    expect(getOwnerDisplayName({ ownerName: 'Ada Lovelace', ownerEmail: 'ada@example.com' })).toBe('Ada Lovelace');
    expect(getOwnerDisplayName({ ownerEmail: 'ada@example.com' })).toBe('ada@example.com');
    expect(getOwnerDisplayName({ ownerId: null })).toBe('Workspace');
  });
});
