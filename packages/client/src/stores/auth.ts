import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@valet/shared';

interface AuthState {
  token: string | null;
  user: User | null;
  orgModelPreferences?: string[];
  isAuthenticated: boolean;
  isValidating: boolean;
  isHydrated: boolean;
  setAuth: (token: string, user: User, orgModelPreferences?: string[]) => void;
  clearAuth: () => void;
  setValidating: (validating: boolean) => void;
  setHydrated: (hydrated: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      orgModelPreferences: undefined,
      isAuthenticated: false,
      isValidating: false,
      isHydrated: false,
      setAuth: (token, user, orgModelPreferences) =>
        set({
          token,
          user,
          orgModelPreferences,
          isAuthenticated: true,
          isValidating: false,
        }),
      clearAuth: () =>
        set({
          token: null,
          user: null,
          orgModelPreferences: undefined,
          isAuthenticated: false,
          isValidating: false,
        }),
      setValidating: (validating) =>
        set({ isValidating: validating }),
      setHydrated: (hydrated) =>
        set({ isHydrated: hydrated }),
    }),
    {
      name: 'valet-auth',
      partialize: (state) => ({
        // Security: Do not persist auth token to localStorage (XSS risk)
        // token: state.token,  // ← Removed: keep in-memory only
        user: state.user,
        orgModelPreferences: state.orgModelPreferences,
        // Note: isAuthenticated will be recomputed on hydration based on token presence
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated(true);
          // After hydration, token will be null (not persisted)
          // App should validate session via secure httpOnly cookie or refresh endpoint
        }
      },
    }
  )
);
