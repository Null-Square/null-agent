import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { DetailBackLink, ListPageShell } from "@null-ai/design-tokens/ui";

type SettingsLayoutProps = {
  children: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  backPath?: string | null;
  backLabel?: string;
};

export default function SettingsLayout({
  children,
  title,
  description,
  actions,
  backPath = "/settings",
  backLabel = "Back to Settings",
}: SettingsLayoutProps) {
  const navigate = useNavigate();
  return (
    <ListPageShell
      title={title}
      subtitle={description}
      actions={actions}
      backLink={
        backPath ? (
          <DetailBackLink
            label={backLabel}
            onClick={() => navigate(backPath)}
          />
        ) : undefined
      }
    >
      {children}
    </ListPageShell>
  );
}
