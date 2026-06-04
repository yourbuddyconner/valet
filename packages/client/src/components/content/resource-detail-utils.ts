import type { User } from '@valet/shared';
import type { AgentPersona, Skill } from '@/api/types';

type SkillPermissionFields = Pick<Skill, 'source' | 'ownerId'>;
type PersonaPermissionFields = Pick<AgentPersona, 'createdBy'>;
type OwnerDisplayFields = {
  ownerId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
};

export function canEditSkill(skill: SkillPermissionFields | null | undefined, user: Pick<User, 'id' | 'role'> | null | undefined) {
  return Boolean(skill && user && skill.source === 'managed' && skill.ownerId === user.id);
}

export function canEditPersona(
  persona: PersonaPermissionFields | null | undefined,
  user: Pick<User, 'id' | 'role'> | null | undefined,
) {
  return Boolean(persona && user && (persona.createdBy === user.id || user.role === 'admin'));
}

export function getOwnerDisplayName(owner: OwnerDisplayFields) {
  return owner.ownerName || owner.ownerEmail || (owner.ownerId ? 'Unknown owner' : 'Workspace');
}

export function getOwnerInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
