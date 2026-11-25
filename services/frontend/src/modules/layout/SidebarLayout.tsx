import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell, Logo, type CellIconName } from "@null-ai/design-tokens/ui";
import { profileInitials, useLocal, useProfile } from "../../local";
import { useLocalAccount } from "../account/localAccount";
const destinations: Array<{ path: string; label: string; icon: CellIconName }> =
  [
    { path: "/agent", label: "Agent", icon: "workbench" },
    { path: "/dashboard", label: "Dashboard", icon: "dashboard" },
    { path: "/assets", label: "Assets", icon: "assets" },
    { path: "/risks", label: "Risks", icon: "findings" },
    { path: "/compliance", label: "Compliance", icon: "compliance" },
    { path: "/runs", label: "Assessments", icon: "runs" },
    { path: "/scopes", label: "Scopes", icon: "scope" },
    { path: "/models", label: "Models", icon: "runner" },
    { path: "/settings", label: "Settings", icon: "settings" },
  ];
export default function SidebarLayout({ children }: { children: ReactNode }) {
  const { id, scopes } = useLocal();
  const profile = useProfile();
  const account = useLocalAccount().data;
  const owner = account?.stage === "ready" ? account.owner : null;
  const name = profile.data?.displayName ?? "";
  const loc = useLocation();
  const nav = useNavigate();
  const scope = scopes.find((s) => s.id === id);
  const items = destinations.map((item) => ({
    id: item.path,
    label: item.label,
    icon: item.icon,
    active:
      loc.pathname === item.path || loc.pathname.startsWith(item.path + "/"),
    onSelect: () => nav(item.path),
  }));
  return (
    <AppShell
      identity={{
        name: scope?.name || "Local workspace",
        meta: owner?.company ?? "NullSquare Local",
        mark: <Logo className="h-8 w-8 shrink-0" />,
        onSelect: () => nav("/scopes"),
      }}
      account={{
        name: name || owner?.company || "Operator",
        meta: owner?.email ?? "Local workspace",
        initials: profileInitials(name),
        onSelect: () => nav("/profile"),
      }}
      groups={[
        { label: "Operate", items: items.slice(0, -3) },
        { label: "Setup", items: items.slice(-3) },
      ]}
    >
      {children}
    </AppShell>
  );
}
