import type {
    SessionFlags,
    ToolAccessPolicy,
    ToolPolicyAction,
    ToolPolicyBehavior,
    ToolPolicyRule,
} from '../../domain/types';
import type { ToolMeta } from './runtime/Tool';

export interface ToolUseDescriptor {
    toolName: string;
    category?: string;
    actions: ToolPolicyAction[];
    risks: string[];
    paths: string[];
    hosts: string[];
    command?: string;
    args: Record<string, unknown>;
}

export interface ToolPermissionDecision {
    behavior: ToolPolicyBehavior;
    reason: string;
    source: 'default' | 'allowlist' | 'denylist' | 'asklist' | 'rule';
    descriptor: ToolUseDescriptor;
    matchedPattern?: string;
    matchedRule?: ToolPolicyRule;
}

export class ToolPolicyChecker {
    hasRequirement(flags: SessionFlags, requirement: string): boolean {
        if (!requirement) {
            return true;
        }
        const parts = requirement.split('.').filter(Boolean);
        if (parts.length === 0) {
            return true;
        }
        let cursor: unknown = flags;
        for (const part of parts) {
            if (!cursor || typeof cursor !== 'object') {
                return false;
            }
            const container = cursor as Record<string, unknown>;
            if (!(part in container)) {
                return false;
            }
            cursor = container[part];
        }
        if (Array.isArray(cursor)) {
            return cursor.length > 0;
        }
        return Boolean(cursor);
    }

    describeToolUse(args: {
        toolName: string;
        toolArgs?: Record<string, unknown>;
        toolMeta?: Pick<ToolMeta, 'category' | 'risks'>;
    }): ToolUseDescriptor {
        const toolArgs = this.asRecord(args.toolArgs);
        const paths = this.extractStringValues(toolArgs, ['path', 'targetPath', 'filePath', 'artifactPath', 'cwd']);
        const hosts = this.extractHosts(toolArgs);
        const command = this.extractCommand(toolArgs);
        const actions = this.deriveActions({
            toolName: args.toolName,
            category: args.toolMeta?.category,
            risks: args.toolMeta?.risks ?? [],
            paths,
            hosts,
            command,
        });

        return {
            toolName: args.toolName,
            category: args.toolMeta?.category,
            actions,
            risks: [...(args.toolMeta?.risks ?? [])],
            paths,
            hosts,
            command,
            args: toolArgs,
        };
    }

    evaluateToolUsage(
        policy: ToolAccessPolicy | undefined,
        descriptor: ToolUseDescriptor,
    ): ToolPermissionDecision {
        if (!policy) {
            return {
                behavior: 'allow',
                reason: `Tool ${descriptor.toolName} is allowed because no tool policy is active.`,
                source: 'default',
                descriptor,
            };
        }

        const denyPattern = this.findMatch(policy.deny, descriptor.toolName);
        if (denyPattern) {
            return {
                behavior: 'deny',
                reason: `Tool ${descriptor.toolName} is denied by policy pattern "${denyPattern}".`,
                source: 'denylist',
                descriptor,
                matchedPattern: denyPattern,
            };
        }

        const denyRule = this.findRuleMatch(policy.rules, 'deny', descriptor);
        if (denyRule) {
            return {
                behavior: 'deny',
                reason: this.describeRuleDecision('deny', descriptor, denyRule),
                source: 'rule',
                descriptor,
                matchedRule: denyRule,
            };
        }

        const askRule = this.findRuleMatch(policy.rules, 'ask', descriptor);
        if (askRule) {
            return {
                behavior: 'ask',
                reason: this.describeRuleDecision('ask', descriptor, askRule),
                source: 'rule',
                descriptor,
                matchedRule: askRule,
            };
        }

        const askPattern = this.findMatch(policy.ask, descriptor.toolName);
        if (askPattern) {
            return {
                behavior: 'ask',
                reason: `Tool ${descriptor.toolName} requires approval by policy pattern "${askPattern}".`,
                source: 'asklist',
                descriptor,
                matchedPattern: askPattern,
            };
        }

        if (Array.isArray(policy.allow) && policy.allow.length > 0) {
            const allowPattern = this.findMatch(policy.allow, descriptor.toolName);
            if (!allowPattern) {
                return {
                    behavior: 'deny',
                    reason: `Tool ${descriptor.toolName} is outside the policy allowlist.`,
                    source: 'allowlist',
                    descriptor,
                };
            }

            const allowRule = this.findRuleMatch(policy.rules, 'allow', descriptor);
            if (allowRule) {
                return {
                    behavior: 'allow',
                    reason: this.describeRuleDecision('allow', descriptor, allowRule),
                    source: 'rule',
                    descriptor,
                    matchedRule: allowRule,
                };
            }

            return {
                behavior: 'allow',
                reason: `Tool ${descriptor.toolName} is allowed by policy pattern "${allowPattern}".`,
                source: 'allowlist',
                descriptor,
                matchedPattern: allowPattern,
            };
        }

        const allowRule = this.findRuleMatch(policy.rules, 'allow', descriptor);
        if (allowRule) {
            return {
                behavior: 'allow',
                reason: this.describeRuleDecision('allow', descriptor, allowRule),
                source: 'rule',
                descriptor,
                matchedRule: allowRule,
            };
        }

        return {
            behavior: 'allow',
            reason: `Tool ${descriptor.toolName} is allowed by the active tool policy.`,
            source: 'default',
            descriptor,
        };
    }

    isToolAllowedByPolicy(policy: ToolAccessPolicy | undefined, toolName: string): boolean {
        const decision = this.evaluateToolUsage(
            policy,
            this.describeToolUse({ toolName }),
        );
        return decision.behavior !== 'deny';
    }

    private deriveActions(args: {
        toolName: string;
        category?: string;
        risks: string[];
        paths: string[];
        hosts: string[];
        command?: string;
    }): ToolPolicyAction[] {
        const actions = new Set<ToolPolicyAction>();
        for (const risk of args.risks) {
            switch (risk) {
                case 'read':
                    actions.add('read');
                    break;
                case 'write':
                    actions.add('write');
                    break;
                case 'network':
                case 'remote':
                    actions.add('network');
                    break;
                case 'compute':
                    actions.add('execute');
                    break;
                default:
                    actions.add('other');
                    break;
            }
        }

        if (args.command) {
            actions.add('execute');
        }
        if (args.hosts.length > 0) {
            actions.add('network');
        }
        if (args.toolName.startsWith('browser')) {
            actions.add('browser');
        }
        if (args.toolName.startsWith('web_')) {
            actions.add('research');
        }
        if (args.toolName.startsWith('plan_') || args.toolName.startsWith('todo_')) {
            actions.add('plan');
        }
        if (args.toolName.startsWith('report_')) {
            actions.add('report');
        }
        if (actions.size === 0) {
            if (args.paths.length > 0) {
                actions.add('read');
            } else {
                actions.add('other');
            }
        }

        return Array.from(actions);
    }

    private extractHosts(args: Record<string, unknown>): string[] {
        const hosts = new Set<string>();
        for (const key of ['url', 'uri']) {
            const values = this.getCandidateStrings(args[key]);
            for (const value of values) {
                const host = this.parseHost(value);
                if (host) {
                    hosts.add(host);
                }
            }
        }

        for (const key of ['host', 'hostname']) {
            const values = this.getCandidateStrings(args[key]);
            for (const value of values) {
                if (value.trim().length > 0) {
                    hosts.add(value.trim().toLowerCase());
                }
            }
        }

        for (const key of ['allowlist_hosts', 'hosts']) {
            for (const value of this.getCandidateStrings(args[key])) {
                if (value.trim().length > 0) {
                    hosts.add(value.trim().toLowerCase());
                }
            }
        }

        for (const key of ['raw_request', 'rawRequest']) {
            const requestText = this.getCandidateStrings(args[key]).join('\n');
            const hostMatch = requestText.match(/^Host:\s*([^\s]+)$/im);
            if (hostMatch?.[1]) {
                hosts.add(hostMatch[1].trim().toLowerCase());
            }
        }

        return Array.from(hosts);
    }

    private extractCommand(args: Record<string, unknown>): string | undefined {
        for (const key of ['command', 'cmd', 'script']) {
            const value = args[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        }
        return undefined;
    }

    private extractStringValues(args: Record<string, unknown>, keys: string[]): string[] {
        const values = new Set<string>();
        for (const key of keys) {
            for (const candidate of this.getCandidateStrings(args[key])) {
                const normalized = candidate.trim();
                if (normalized.length > 0) {
                    values.add(normalized);
                }
            }
        }
        return Array.from(values);
    }

    private getCandidateStrings(value: unknown): string[] {
        if (typeof value === 'string') {
            return [value];
        }
        if (Array.isArray(value)) {
            return value.filter((entry): entry is string => typeof entry === 'string');
        }
        return [];
    }

    private findRuleMatch(
        rules: ToolPolicyRule[] | undefined,
        behavior: ToolPolicyBehavior,
        descriptor: ToolUseDescriptor,
    ): ToolPolicyRule | undefined {
        return rules?.find((rule) => {
            if (rule.behavior !== behavior) {
                return false;
            }

            const hasMatcher =
                rule.tool !== undefined ||
                rule.category !== undefined ||
                rule.action !== undefined ||
                rule.path !== undefined ||
                rule.host !== undefined ||
                rule.command !== undefined;
            if (!hasMatcher) {
                return false;
            }

            if (!this.matchesAny(rule.tool, [descriptor.toolName])) {
                return false;
            }
            if (!this.matchesAny(rule.category, descriptor.category ? [descriptor.category] : [])) {
                return false;
            }
            if (!this.matchesAny(rule.action, descriptor.actions)) {
                return false;
            }
            if (!this.matchesAny(rule.path, descriptor.paths)) {
                return false;
            }
            if (!this.matchesAny(rule.host, descriptor.hosts)) {
                return false;
            }
            if (!this.matchesAny(rule.command, descriptor.command ? [descriptor.command] : [])) {
                return false;
            }

            return true;
        });
    }

    private matchesAny(
        patterns: string | string[] | undefined,
        values: string[],
    ): boolean {
        if (patterns === undefined) {
            return true;
        }
        if (values.length === 0) {
            return false;
        }
        const patternList = Array.isArray(patterns) ? patterns : [patterns];
        return patternList.some((pattern) => values.some((value) => this.matchPattern(pattern, value)));
    }

    private findMatch(patterns: string[] | undefined, value: string): string | undefined {
        return patterns?.find((pattern) => this.matchPattern(pattern, value));
    }

    private describeRuleDecision(
        behavior: ToolPolicyBehavior,
        descriptor: ToolUseDescriptor,
        rule: ToolPolicyRule,
    ): string {
        const note = rule.note ? ` ${rule.note}` : '';
        switch (behavior) {
            case 'deny':
                return `Tool ${descriptor.toolName} is denied by a matching tool policy rule.${note}`.trim();
            case 'ask':
                return `Tool ${descriptor.toolName} requires approval by a matching tool policy rule.${note}`.trim();
            case 'allow':
            default:
                return `Tool ${descriptor.toolName} is allowed by a matching tool policy rule.${note}`.trim();
        }
    }

    private parseHost(value: string): string | undefined {
        try {
            const parsed = new URL(value);
            return parsed.host.toLowerCase();
        } catch {
            return undefined;
        }
    }

    private asRecord(value: unknown): Record<string, unknown> {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return {};
    }

    private matchPattern(pattern: string, value: string): boolean {
        if (pattern === '*') {
            return true;
        }
        const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp(`^${escaped}$`, 'i');
        return regex.test(value);
    }
}
