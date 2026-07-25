// Framework-agnostic auth state, readable from non-React code (RTK Query
// prepareHeaders). Kept in sync by the React AuthProvider in lib/auth.tsx.

export type AuthMode = "dev" | "clerk";

export const AUTH_MODE: AuthMode =
  (process.env.NEXT_PUBLIC_AUTH_MODE as AuthMode) === "clerk" ? "clerk" : "dev";

export const DEV_USER_KEY = "recallix.devUserId";
export const DEFAULT_DEV_USER = "usr_dev";

interface AuthStore {
  mode: AuthMode;
  devUserId: string;
  // In clerk mode, the AuthProvider registers a token getter here.
  tokenGetter: (() => Promise<string | null>) | null;
}

export const authStore: AuthStore = {
  mode: AUTH_MODE,
  devUserId: DEFAULT_DEV_USER,
  tokenGetter: null,
};

// Hydrate the dev user id from localStorage as early as possible (client only).
if (typeof window !== "undefined" && AUTH_MODE === "dev") {
  try {
    const stored = window.localStorage.getItem(DEV_USER_KEY);
    if (stored) authStore.devUserId = stored;
  } catch {
    /* ignore storage errors */
  }
}

/** Headers attached to every Spring `/api/v1/**` request. */
export async function buildAuthHeaders(): Promise<Record<string, string>> {
  if (authStore.mode === "clerk") {
    try {
      const token = authStore.tokenGetter
        ? await authStore.tokenGetter()
        : null;
      if (token) return { Authorization: `Bearer ${token}` };
    } catch {
      /* fall through — request will 401 and surface an error state */
    }
    return {};
  }
  // dev mode
  return { "X-Dev-User": authStore.devUserId || DEFAULT_DEV_USER };
}
