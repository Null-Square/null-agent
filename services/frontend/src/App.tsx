import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useParams,
} from "react-router-dom";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ThemeProvider,
  ListSkeleton,
  ListPageShell,
  Button,
} from "@null-ai/design-tokens/ui";
import { LocalProvider, useLocal } from "./local";
import SidebarLayout from "./modules/layout/SidebarLayout";
import Compliance from "./routes/Compliance";
import ComplianceControl from "./routes/ComplianceControl";
import { Scopes } from "./modules/scopes/ui/ScopesPage";
import ScopeDetailPage from "./modules/scopes/ui/ScopeDetailPage";
import ProfilePage from "./modules/settings/ui/ProfilePage";
import { Settings } from "./pages/Settings";
import { Review } from "./pages/Review";
import RunsPage from "./modules/runs/ui/RunsPage";
import RunDetailPage from "./modules/runs/ui/RunDetailPage";
import DashboardPage from "./modules/dashboard/ui/DashboardPage";
import AssetsPage from "./modules/assets/ui/AssetsPage";
import AssetDetailPage from "./modules/assets/ui/AssetDetailPage";
import { Reports, Risks } from "./pages/Results";
import { LocalAuthPage, useLocalAccount } from "./modules/account/localAccount";
import { Onboarding, Welcome } from "./modules/account/Onboarding";
import ModelsPage from "./modules/settings/ui/ModelsPage";
import "./index.css";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function RunWorkbench() {
  const { id: requested } = useParams();
  const { id, scopes, select } = useLocal();
  const scope = scopes.find((item) => item.id === requested);
  useEffect(() => {
    if (scope && id !== scope.id) select(scope.id);
  }, [scope, id, select]);
  if (!scope) return <Navigate to="/runs" replace />;
  return id === scope.id ? (
    <Review key={id} />
  ) : (
    <ListSkeleton label="Reading assessment" />
  );
}

function Body() {
  const { id, loading, error, refresh } = useLocal();
  return (
    <SidebarLayout>
      {loading ? (
        <div className="p-8">
          <ListSkeleton label="Reading workspace" />
        </div>
      ) : error ? (
        <ListPageShell title="Workspace unavailable">
          <p className="notice" role="alert">
            {error.message}
          </p>
          <Button onClick={() => void refresh()}>Retry</Button>
        </ListPageShell>
      ) : (
        <Routes>
          <Route path="/agent" element={id ? <Review key={id} /> : <Navigate to="/scopes" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/assets" element={<AssetsPage key={id} />} />
          <Route path="/assets/detail" element={<AssetDetailPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/organization" element={<Settings />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/scopes" element={<Scopes />} />
          <Route path="/scopes/:id" element={<ScopeDetailPage />} />
          <Route path="/run" element={<Navigate to="/runs" replace />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/runs/:id/workbench" element={<RunWorkbench />} />
          {id && (
            <>
              <Route path="/compliance" element={<Compliance key={id} />} />
              <Route
                path="/compliance/:frameworkKey/:controlId"
                element={<ComplianceControl key={id} />}
              />
              <Route path="/risks" element={<Risks />} />
              <Route path="/risks/:id" element={<Risks />} />
              <Route
                path="/findings"
                element={<Navigate to="/risks" replace />}
              />
              <Route path="/findings/:id" element={<Risks />} />
              <Route path="/reports" element={<Reports />} />
              <Route
                path="/code-review"
                element={
                  <Navigate
                    to={"/runs/" + encodeURIComponent(id) + "/workbench"}
                    replace
                  />
                }
              />
            </>
          )}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      )}
    </SidebarLayout>
  );
}
function SavedPreviewLink() {
  const { pathname, search } = useLocation();
  const target = pathname.slice("/demo".length);
  return <Navigate to={(target === "/run" ? "/runs" : target || "/dashboard") + search} replace />;
}

function Workspace() {
  const account = useLocalAccount();
  if (!account.data) {
    return (
      <ListPageShell title="Local workspace">
        {account.isError ? <p role="alert">The local account is unavailable.</p> : <ListSkeleton label="Reading workspace" />}
      </ListPageShell>
    );
  }
  if (account.data.stage !== "ready") {
    return <Navigate to={account.data.stage === "onboarding" ? "/onboarding" : "/auth"} replace />;
  }
  return <LocalProvider><Body /></LocalProvider>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<LocalAuthPage />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/demo/*" element={<SavedPreviewLink />} />
          <Route path="*" element={<Workspace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>,
);
