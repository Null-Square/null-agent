import { DetailBackLink, ListPageShell } from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

type SettingsLayoutProps = {
  children: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  backPath?: string | null;
  backLabel?: string;
};

/**
 * SettingsLayout — the settings-side entry to the one page shell.
 *
 * This used to carry its own copy of the shell: the same `min-h-screen`
 * wrapper, the same 1600px column, the same heading block, and a hand-rolled
 * back button with a lucide chevron. Five pages rendered through that copy, so
 * every drift between it and `ListPageShell` showed up as settings looking
 * subtly unlike the rest of the app.
 *
 * It now only decides *where back goes* — which is the one thing settings
 * knows that the shell doesn't — and hands the rest to the shared shell and
 * the shared `DetailBackLink`.
 */
export default function SettingsLayout({
  children,
  title,
  description,
  actions,
  backPath,
  backLabel,
}: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const paths = useAppPaths();

  const isHub = location.pathname === paths.settingsHome || location.pathname === `${paths.settingsHome}/`;
  const isMainNav = [
    paths.scopesList,
    paths.runnersList,
    paths.credentialsList,
    paths.automationsList,
    paths.settingsHome,
  ].includes(location.pathname);

  // A nested page returns to its own list; anything else returns to Settings.
  const parent = [
    { prefix: `${paths.runnersList}/`, path: paths.runnersList, label: 'Back to Runners' },
    { prefix: `${paths.automationsList}/`, path: paths.automationsList, label: 'Back to Automations' },
    { prefix: `${paths.scopesList}/`, path: paths.scopesList, label: 'Back to Scopes' },
  ].find((candidate) => location.pathname.startsWith(candidate.prefix));

  const showBackNav = backPath !== undefined ? backPath !== null : !isHub && !isMainNav;
  const resolvedBackPath = backPath ?? parent?.path ?? paths.settingsHome;
  const resolvedBackLabel = backLabel ?? parent?.label ?? 'Back to Settings';

  return (
    <ListPageShell
      title={title}
      subtitle={description}
      actions={actions}
      backLink={
        showBackNav ? (
          <DetailBackLink label={resolvedBackLabel} onClick={() => navigate(resolvedBackPath)} />
        ) : undefined
      }
    >
      {children}
    </ListPageShell>
  );
}
