import { DashboardPage, DashboardErrorBoundary } from '@modules/dashboard';

/**
 * The boundary lives here rather than inside DashboardPage because a boundary
 * has to be an ancestor of what it protects — DashboardPage's own hooks run
 * before its render, so a wrap inside it would never catch them. Mirrors how
 * ChatPage mounts its module boundary.
 */
export default function Dashboard() {
  return (
    <DashboardErrorBoundary>
      <DashboardPage />
    </DashboardErrorBoundary>
  );
}
