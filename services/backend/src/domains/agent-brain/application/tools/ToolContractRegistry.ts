export type ToolContract = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

type RegistrationOptions = {
  priority?: number;
  source?: string;
};

type RegisteredToolContract = {
  contract: ToolContract;
  priority: number;
  source?: string;
};

export type ToolContractRegistryEntry = {
  contract: ToolContract;
  priority: number;
  source?: string;
};

const cloneContract = (contract: ToolContract): ToolContract =>
  JSON.parse(JSON.stringify(contract)) as ToolContract;

export class ToolContractRegistry {
  private readonly contracts = new Map<string, RegisteredToolContract>();

  register(contract: ToolContract, options: RegistrationOptions = {}): ToolContract {
    const normalizedName = contract.name.trim();
    const priority = Number.isFinite(options.priority) ? Number(options.priority) : 0;
    const existing = this.contracts.get(normalizedName);
    if (existing && existing.priority > priority) {
      return cloneContract(existing.contract);
    }

    const next = cloneContract({
      ...contract,
      name: normalizedName,
      description: contract.description.trim(),
    });
    this.contracts.set(normalizedName, {
      contract: next,
      priority,
      source: options.source,
    });
    return cloneContract(next);
  }

  get(name: string): ToolContract | undefined {
    const contract = this.contracts.get(name)?.contract;
    return contract ? cloneContract(contract) : undefined;
  }

  list(): ToolContract[] {
    return Array.from(this.contracts.values()).map((entry) => cloneContract(entry.contract));
  }

  listEntries(): ToolContractRegistryEntry[] {
    return Array.from(this.contracts.values())
      .map((entry) => ({
        contract: cloneContract(entry.contract),
        priority: entry.priority,
        source: entry.source,
      }))
      .sort((left, right) =>
        left.priority - right.priority ||
        left.contract.name.localeCompare(right.contract.name),
      );
  }

  getEntry(name: string): ToolContractRegistryEntry | undefined {
    const entry = this.contracts.get(name);
    if (!entry) {
      return undefined;
    }
    return {
      contract: cloneContract(entry.contract),
      priority: entry.priority,
      source: entry.source,
    };
  }
}

export const toolContractRegistry = new ToolContractRegistry();

export const registerToolContract = (
  contract: ToolContract,
  options?: RegistrationOptions,
): ToolContract =>
  toolContractRegistry.register(contract, options);
