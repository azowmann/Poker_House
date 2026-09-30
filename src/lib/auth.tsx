/**
 * Auth session state for the whole app.
 *
 * Supabase already persists the session to AsyncStorage (see `@/lib/supabase`);
 * this exposes it to React and keeps it current. Two things feed the session:
 *
 *   - `getSession()` once on mount, which reads the stored session back from disk.
 *     This is the "skip login if we have a session" step from ARCHITECTURE.md.
 *   - `onAuthStateChange`, which fires on sign-in, sign-out, and token refresh.
 *
 * Screens never call `supabase.auth` to find out who is signed in - they read
 * `useAuth()`, so there is one answer everywhere.
 *
 * `profile` (display name, avatar) rides alongside the session rather than
 * living only on the profile screen: the header-right profile button needs to
 * show a user's actual avatar on every screen, not just the one where it can be
 * changed. It is refetched whenever the session changes, and `refreshProfile`
 * lets the profile screen push a name/avatar change out to everywhere else
 * immediately, rather than waiting for the next sign-in.
 */
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { getProfile, type Profile } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

type AuthState = {
  session: Session | null;
  /**
   * True until the stored session has been read back. Screens must wait for this
   * before deciding where to send the user, or a returning player gets bounced to
   * the sign-in screen for a frame before landing on their houses.
   */
  isRestoring: boolean;
  /** Null while signed out, or before the profile row has loaded. */
  profile: Profile | null;
  /** Re-fetch the profile after changing the name or avatar. */
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  session: null,
  isRestoring: true,
  profile: null,
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async (userId: string) => {
    try {
      setProfile(await getProfile(userId));
    } catch {
      // Not fatal - the header button falls back to the default icon, and the
      // profile screen surfaces its own load error if this keeps failing.
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setIsRestoring(false);
      if (data.session) void loadProfile(data.session.user.id);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      // A sign-out event can arrive before getSession() resolves; either way the
      // question of "is there a session" is now answered.
      setIsRestoring(false);
      if (nextSession) {
        void loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (session) await loadProfile(session.user.id);
  }, [session, loadProfile]);

  return (
    <AuthContext.Provider value={{ session, isRestoring, profile, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
