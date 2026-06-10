import type { User } from '@valet/shared';

export interface AuthMeResponse {
  user: User;
  orgModelPreferences?: string[];
}

export type SetAuth = (token: string, user: User, orgModelPreferences?: string[]) => void;

export function applyAuthMeResponse({
  token,
  response,
  setAuth,
}: {
  token: string;
  response: AuthMeResponse;
  setAuth: SetAuth;
}) {
  setAuth(token, response.user, response.orgModelPreferences);
}
