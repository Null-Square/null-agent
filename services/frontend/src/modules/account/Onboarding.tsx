import { useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { Button, FullLogo, Input } from "@null-ai/design-tokens/ui";
import { changeAccount, useLocalAccount, type LocalOwner } from "./localAccount";

const steps = [
  { label: "Organization", title: "Create your organization", description: "Give your workspace a name." },
  { label: "Website", title: "Add your website", description: "Enter the website you own or are authorized to assess." },
  { label: "Authorization", title: "Authorize the assessment", description: "Confirm these details to create your local scope." },
] as const;

function SetupWizard({ owner }: { owner: LocalOwner }) {
  const [name, setName] = useState(owner.company ?? "");
  const [website, setWebsite] = useState(owner.website ?? "");
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const step = steps[index];
  const done = index === steps.length - 1;
  const invalid = index === 0 ? name.trim().length < 3 : index === 1 ? !website.trim() : false;

  function move(delta: number) {
    setError("");
    setDirection(delta);
    setIndex(index + delta);
  }

  async function advance(event: FormEvent) {
    event.preventDefault();
    if (saving || invalid) return;
    if (!done) {
      move(1);
      return;
    }
    setSaving(true);
    try {
      if (!owner.website) await changeAccount("company", { name, website });
      window.location.replace("/welcome");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not finish setup.");
      setSaving(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background font-sans text-foreground">
      <header className="px-5 py-5 md:px-8">
        <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-4 text-sm text-muted-foreground">
          <span>New workspace</span>
          <div className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map(({ label }, position) => (
              <span key={label} className={`block h-1 transition-all duration-300 ${position === index ? "w-8 bg-primary" : position < index ? "w-1.5 bg-primary/40" : "w-1.5 bg-border"}`} />
            ))}
          </div>
          <span className="justify-self-end">{index + 1} / {steps.length}</span>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16 pt-2 md:px-8">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.form
            key={index}
            initial={{ opacity: 0, x: direction * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction * -24 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            onSubmit={advance}
            className="mx-auto flex w-full max-w-2xl flex-col items-center text-center"
          >
            <p className="text-sm text-muted-foreground">{step.label}</p>
            <h1 className="mt-3 text-2xl font-extrabold tracking-[-0.035em] md:text-4xl">{step.title}</h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">{step.description}</p>
            <div className="mt-8 w-full max-w-xl">
              {index === 0 && (
                <Input aria-label="Organization name" value={name} onChange={event => setName(event.target.value)}
                  autoComplete="organization" placeholder="Acme Inc." autoFocus maxLength={120} required
                  className="h-14 px-6 text-center text-base font-medium focus:border-primary focus-visible:ring-0" />
              )}
              {index === 1 && (
                <div className="relative">
                  <Input aria-label="Target value" value={website} onChange={event => setWebsite(event.target.value)}
                    autoComplete="url" placeholder="example.com" autoFocus maxLength={2048} required
                    className="h-14 px-6 text-center font-mono text-base font-bold focus:border-primary focus-visible:ring-0" />
                  <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-5 flex items-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Website</span>
                </div>
              )}
              {done && (
                <div className="border border-border/40 text-left">
                  <p className="border-b border-border/40 px-6 py-4 text-sm text-primary">Workspace setup</p>
                  <dl className="divide-y divide-border/30">
                    {[
                      ["Organization", name],
                      ["Website", website],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-6 px-6 py-3">
                        <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 truncate font-mono text-[13px]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
            {error && <p className="mt-5 text-sm text-destructive" role="alert">{error}</p>}
            <div className="mt-10 flex items-center gap-3">
              {index > 0 && (
                <Button type="button" variant="ghost" onClick={() => move(-1)} disabled={saving} className="h-11 px-4">
                  <ChevronLeft className="h-3.5 w-3.5" /> Back
                </Button>
              )}
              <Button type="submit" disabled={invalid || saving} className="h-11 min-w-[180px]">
                {done ? <>I authorize <Check className="h-3.5 w-3.5" /></> : <>Continue <ChevronRight className="h-3.5 w-3.5" /></>}
              </Button>
            </div>
          </motion.form>
        </AnimatePresence>
      </main>
    </div>
  );
}

export function Onboarding() {
  const { data, isError } = useLocalAccount();
  if (!data) return <p className="p-8" role="status">{isError ? "The local account is unavailable." : "Opening setup…"}</p>;
  if (!("owner" in data)) return <Navigate to="/auth" replace />;
  return <SetupWizard owner={data.owner} />;
}

export function Welcome() {
  const { data } = useLocalAccount();
  if (!data) return <p className="p-8" role="status">Opening workspace…</p>;
  if (data.stage !== "ready") return <Navigate to={data.stage === "onboarding" ? "/onboarding" : "/auth"} replace />;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background p-6 text-center text-foreground">
      <FullLogo className="mb-8 h-12 w-auto" variant="light" />
      <h1 className="mb-4 text-4xl font-extrabold tracking-[-0.035em] md:text-5xl">Setup complete</h1>
      <p className="mb-12 text-sm text-muted-foreground">{data.owner.company} is ready</p>
      <Button asChild size="lg" className="h-14 w-full max-w-xs">
        <Link to="/scopes">Go to Console</Link>
      </Button>
    </main>
  );
}
