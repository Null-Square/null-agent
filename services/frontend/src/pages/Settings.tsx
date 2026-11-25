import { Link } from "react-router-dom";
import { Button, SectionPanel } from "@null-ai/design-tokens/ui";
import { useLocalAccount } from "../modules/account/localAccount";
import SettingsLayout from "../modules/settings/ui/SettingsLayout";

export function Settings() {
  const account = useLocalAccount().data;
  const owner = account?.stage === "ready" ? account.owner : null;
  return (
    <SettingsLayout title="Settings" description="Manage the local organization." backPath={null}>
      <SectionPanel title="Organization">
        <dl className="grid max-w-lg gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Organization name</dt>
            <dd className="mt-1 font-medium">{owner?.company}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Website</dt>
            <dd className="mt-1 font-medium">{owner?.website}</dd>
          </div>
        </dl>
        <div className="mt-6 flex gap-3">
          <Button asChild variant="outline"><Link to="/models">Model settings</Link></Button>
          <Button asChild variant="outline"><Link to="/profile">Profile</Link></Button>
        </div>
      </SectionPanel>
    </SettingsLayout>
  );
}
