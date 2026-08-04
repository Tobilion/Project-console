import { useState, useEffect, useCallback } from 'react';
import { formatUserName } from '../utils/formatUserName';

export interface UserProfile {
  name: string;
  title: string;
  customRole: string;
}

const DEFAULT_PROFILE: UserProfile = {
  name: 'Tobi',
  title: 'Master',
  customRole: 'Software Engineer',
};

/** Client state for the user profile persisted to the server (GET/POST /api/profile).
 *  Starts from the same defaults the server uses, so first paint matches today's
 *  hardcoded hero greeting exactly; the profile loads asynchronously right after. */
export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then((res) => res.json())
      .then((data) => {
        if (data?.userProfile) setProfile(data.userProfile);
      })
      .catch(() => console.warn('Using default local profile state'))
      .finally(() => setLoaded(true));
  }, []);

  const updateProfile = useCallback(async (updates: Partial<UserProfile>) => {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userProfile: updated }),
      });
      const data = await res.json();
      // Reflect the server's sanitized/merged value back (it may fall back on invalid input).
      if (data?.userProfile) setProfile(data.userProfile);
    } catch (err) {
      console.error('Failed to persist profile to server:', err);
    }
  }, [profile]);

  const getFormattedName = useCallback((): string => formatUserName(profile), [profile]);

  return { profile, updateProfile, getFormattedName, loaded };
}
