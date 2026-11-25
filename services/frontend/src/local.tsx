import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComplianceReadinessResponse } from "./modules/security-ops/types";
export type Provider = "ollama" | "openai" | "anthropic" | "chatgpt";
export type RiskState =
  | "potential"
  | "confirmed"
  | "accepted"
  | "resolved"
  | "false_positive";
export interface Finding {
  id: string;
  source: string;
  title: string;
  severity: string;
  description: string;
  remediation?: string;
  target?: string;
  state: RiskState;
  ruleId: string;
  cweIds: string[];
  cvssScore?: number;
  cvssVector?: string;
  assetValue?: string;
  assetKind?: string;
  location?: { path: string; startLine?: number; endLine?: number };
  evidence: { id: string; title: string; createdAt: string }[];
  history: {
    id: string;
    type: "imported" | "status_changed";
    createdAt: string;
    fromStatus?: RiskState;
    toStatus: RiskState;
  }[];
}
export interface Artifact {
  id: string;
  name: string;
  createdAt: string;
  kind?: string;
  sizeBytes: number;
  findingCount: number;
  excerpt?: string;
  sourcePreview?: { startLine: number; endLine: number; sourceExcerpt: string };
  controlId?: string;
  controlFramework?: string;
  canRelink?: boolean;
}
export interface Review {
  id: string;
  model: string;
  provider: string;
  workflow: string;
  text: string;
  createdAt: string;
  artifactIds: string[];
}
export interface Scope {
  findingCount: number;
  artifactCount: number;
  reviewCount: number;
  id: string;
  name: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project extends Scope {
  revision: number;
  framework: string;
  artifacts: Artifact[];
  findings: Finding[];
  reviews: Review[];
  review: Review | null;
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const value = await res.json().catch(() => ({}));
    throw new Error(value.error || "Local service returned " + res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}
export const projectPath = (id: string) =>
  "/projects/" + encodeURIComponent(id);
export const projectAPI = <T,>(
  id: string,
  suffix = "",
  method = "GET",
  body?: unknown,
) => request<T>(projectPath(id) + suffix, method, body);
export const controlPath = (framework: string, id: string) =>
  "/compliance/" + encodeURIComponent(framework) + "/" + encodeURIComponent(id);
export const evidenceURL = (id: string, artifact: string) =>
  "/api" + projectPath(id) + "/artifacts/" + encodeURIComponent(artifact);
type Local = {
  id: string;
  scopes: Scope[];
  project?: Project;
  loading: boolean;
  error: Error | null;
  select: (id: string) => void;
  refresh: () => Promise<void>;
};
const LocalContext = createContext<Local | null>(null);
export const useLocal = () => useContext(LocalContext)!;
export function LocalProvider({ children }: { children: ReactNode }) {
  const cache = useQueryClient();
  const [selected, setSelected] = useState(
    () => localStorage.getItem("nullsquare.activeScope") || "",
  );
  const scopes = useQuery({
    queryKey: ["scopes"],
    queryFn: () => request<Scope[]>("/projects"),
  });
  const items = scopes.data || [];
  const id = items.some((s) => s.id === selected)
    ? selected
    : items[0]?.id || "";
  const project = useQuery({
    queryKey: ["scope", id],
    queryFn: () => projectAPI<Project>(id),
    enabled: !!id,
  });
  function select(id: string) {
    setSelected(id);
    localStorage.setItem("nullsquare.activeScope", id);
  }
  async function refresh() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["scopes"] }),
      cache.invalidateQueries({ queryKey: ["scope", id] }),
      cache.invalidateQueries({ queryKey: ["readiness", id] }),
    ]);
  }
  return (
    <LocalContext.Provider
      value={{
        id,
        scopes: items,
        project: project.data,
        loading: scopes.isLoading || project.isLoading,
        error: scopes.error || project.error,
        select,
        refresh,
      }}
    >
      {children}
    </LocalContext.Provider>
  );
}
export function useReadiness() {
  const { id } = useLocal();
  return useQuery({
    queryKey: ["readiness", id],
    queryFn: () => projectAPI<ComplianceReadinessResponse>(id, "/readiness"),
    enabled: !!id,
  });
}
export interface ModelPreference {
  provider: Provider;
  model: string | null;
}
export function usePreference() {
  return useQuery({
    queryKey: ["model-settings"],
    queryFn: () => request<ModelPreference>("/settings/model"),
  });
}

export interface LocalProfile {
  displayName: string;
}

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => request<LocalProfile>("/profile"),
  });
}

export function profileInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? "")
      .join("")
      .toUpperCase() || "OP"
  );
}
