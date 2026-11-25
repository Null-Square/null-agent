import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, DetailSection, Input } from "@null-ai/design-tokens/ui";
import {
  profileInitials,
  request,
  useProfile,
  type LocalProfile,
} from "../../../local";
import SettingsLayout from "./SettingsLayout";
import { localSignOut, useLocalAccount } from "../../account/localAccount";

function ProfileForm({ profile }: { profile: LocalProfile }) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const cache = useQueryClient();
  const account = useLocalAccount().data;
  const signOut = useMutation({ mutationFn: localSignOut });
  const save = useMutation({
    mutationFn: () => request<LocalProfile>("/profile", "PUT", { displayName }),
    onSuccess: (saved) => {
      cache.setQueryData(["profile"], saved);
      setDisplayName(saved.displayName);
    },
  });
  return (
    <div className="pb-12">
      <div className="flex flex-wrap items-center justify-between gap-6 border-b border-border/60 pb-8">
        <div className="flex min-w-0 items-center gap-5">
          <div className="flex h-16 w-16 flex-none items-center justify-center border border-border bg-elevated font-mono text-xl font-bold text-foreground">
            {profileInitials(profile.displayName)}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[26px] font-extrabold leading-tight tracking-[-0.03em] text-foreground">
              {profile.displayName || "Operator"}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Local workspace
            </p>
          </div>
        </div>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-10 xl:grid-cols-2 xl:gap-16">
        <DetailSection label="Profile details">
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-2">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="full-name"
              >
                Full name
              </label>
              <Input
                id="full-name"
                value={displayName}
                maxLength={120}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  save.reset();
                }}
                placeholder="Enter your name"
                disabled={save.isPending}
                className="h-11 rounded-none border-border bg-input text-foreground focus:border-primary"
              />
            </div>
            <Button
              type="submit"
              disabled={
                save.isPending || displayName.trim() === profile.displayName
              }
            >
              Save changes
            </Button>
            {save.isSuccess && <p role="status">Profile saved.</p>}
            {save.isError && (
              <p role="alert" className="notice">
                {save.error.message}
              </p>
            )}
          </form>
        </DetailSection>
        <DetailSection label="Account">
          {account?.stage === "ready" && <p className="mb-4">{account.owner.email}</p>}
          <Button variant="outline" onClick={() => signOut.mutate()} loading={signOut.isPending}>Sign out</Button>
          {signOut.error && <p role="alert">{signOut.error.message}</p>}
        </DetailSection>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const profile = useProfile();
  return (
    <SettingsLayout
      title="Profile"
      description="Manage your local display name."
    >
      {profile.data ? (
        <ProfileForm profile={profile.data} />
      ) : profile.isError ? (
        <div>
          <p role="alert">{profile.error.message}</p>
          <Button onClick={() => void profile.refetch()}>Retry</Button>
        </div>
      ) : (
        <p role="status">Loading profile…</p>
      )}
    </SettingsLayout>
  );
}
