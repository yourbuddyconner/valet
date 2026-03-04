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
        token: state.token,
        user: state.user,
        orgModelPreferences: state.orgModelPreferences,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated(true);
        }
      },
    }
  )
);
