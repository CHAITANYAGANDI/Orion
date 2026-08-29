import { AppShell } from "@/components/app-shell";
import { AuthGate } from "@/components/auth-gate";

/**
 * Everything behind the login.
 *
 * <p><AuthGate> sits OUTSIDE <AppShell> on purpose. The shell is not chrome
 * that happens to be there while the page loads -- it queries on mount (the
 * notification bell, the plan allowance, the folder tree), so gating inside it
 * would leave exactly those three requests racing the Clerk token, which is the
 * bug this is here to close.
 */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
