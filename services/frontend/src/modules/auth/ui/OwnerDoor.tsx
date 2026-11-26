/**
 * What a browser sees without the owner key: how to open Null AI as yourself. Nothing else loads
 * behind it, because every API call without the key is refused.
 */
export function OwnerDoor() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-xl text-center">
        <div className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Null AI</div>
        <h1 className="mt-4 font-mono text-2xl font-bold uppercase tracking-tight">Open Null AI from its link</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          Null AI printed a link when it started. Open it once in this browser, and it stays open here.
          Anything without it, a container or another program, is not you.
        </p>
        <div className="mt-6 grid gap-2 text-left">
          <code className="block border border-border bg-elevated/30 px-4 py-3 font-mono text-xs">npm run link -w services/backend</code>
          <code className="block border border-border bg-elevated/30 px-4 py-3 font-mono text-xs">docker compose exec backend npm run link</code>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Either prints the link again.</p>
      </div>
    </main>
  );
}

export default OwnerDoor;
