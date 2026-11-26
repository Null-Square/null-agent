export class JsonRepairService {
    parse(argsJson: string): unknown {
        if (!argsJson) {
            return {};
        }
        const trimmed = argsJson.trim();
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            const repaired = this.repairJson(trimmed);
            if (repaired) {
                try {
                    return JSON.parse(repaired);
                } catch (repairError) {
                    throw new Error(
                        `Failed to parse tool arguments after repair attempt: ${(repairError as Error).message}`,
                    );
                }
            }
            throw new Error(`Failed to parse tool arguments: ${(error as Error).message}`);
        }
    }

    private repairJson(raw: string): string | null {
        const extracted = this.extractFirstJsonValue(raw);
        if (!extracted) {
            return null;
        }

        const normalizedQuotes = this.normalizeSingleQuotedStrings(extracted);
        const withoutTrailingCommas = normalizedQuotes.replace(/,\s*([}\]])/g, '$1');
        const withQuotedKeys = withoutTrailingCommas.replace(/([{,]\s*)([A-Za-z0-9_-]+)\s*:/g, '$1"$2":');

        return this.normalizeUnquotedLiterals(withQuotedKeys);
    }

    private normalizeSingleQuotedStrings(raw: string): string {
        let result = '';
        let currentQuote: '"' | "'" | null = null;
        let escape = false;
        let singleQuotedBuffer = '';

        for (let i = 0; i < raw.length; i++) {
            const char = raw[i];

            if (currentQuote === '"') {
                result += char;
                if (escape) {
                    escape = false;
                    continue;
                }
                if (char === '\\') {
                    escape = true;
                    continue;
                }
                if (char === '"') {
                    currentQuote = null;
                }
                continue;
            }

            if (currentQuote === "'") {
                if (escape) {
                    switch (char) {
                        case "'":
                            singleQuotedBuffer += "'";
                            break;
                        case '"':
                            singleQuotedBuffer += '"';
                            break;
                        case '\\':
                            singleQuotedBuffer += '\\';
                            break;
                        case 'n':
                            singleQuotedBuffer += '\n';
                            break;
                        case 'r':
                            singleQuotedBuffer += '\r';
                            break;
                        case 't':
                            singleQuotedBuffer += '\t';
                            break;
                        case 'b':
                            singleQuotedBuffer += '\b';
                            break;
                        case 'f':
                            singleQuotedBuffer += '\f';
                            break;
                        case 'u': {
                            const codePoint = raw.slice(i + 1, i + 5);
                            if (/^[0-9A-Fa-f]{4}$/.test(codePoint)) {
                                singleQuotedBuffer += String.fromCharCode(parseInt(codePoint, 16));
                                i += 4;
                            } else {
                                singleQuotedBuffer += 'u';
                            }
                            break;
                        }
                        default:
                            singleQuotedBuffer += char;
                            break;
                    }
                    escape = false;
                    continue;
                }

                if (char === '\\') {
                    escape = true;
                    continue;
                }

                if (char === "'") {
                    result += JSON.stringify(singleQuotedBuffer);
                    singleQuotedBuffer = '';
                    currentQuote = null;
                    continue;
                }

                singleQuotedBuffer += char;
                continue;
            }

            if (char === '"') {
                currentQuote = '"';
                result += char;
                continue;
            }

            if (char === "'") {
                currentQuote = "'";
                singleQuotedBuffer = '';
                escape = false;
                continue;
            }

            result += char;
        }

        if (currentQuote === "'") {
            result += JSON.stringify(singleQuotedBuffer);
        }

        return result;
    }

    private normalizeUnquotedLiterals(raw: string): string {
        const replacements: Record<string, string> = {
            True: 'true',
            False: 'false',
            None: 'null',
            undefined: 'null',
        };

        let result = '';
        let currentQuote: '"' | "'" | null = null;
        let escape = false;
        let expectingValue = false;
        const stack: Array<'object' | 'array'> = [];

        const normalizeBareValue = (value: string): string => {
            const trimmedEnd = value.trimEnd();
            const suffix = value.slice(trimmedEnd.length);
            const replacement = replacements[trimmedEnd] ?? trimmedEnd;

            if (replacement.length === 0) {
                return value;
            }

            try {
                JSON.parse(replacement);
                return replacement + suffix;
            } catch {
                return JSON.stringify(replacement) + suffix;
            }
        };

        for (let i = 0; i < raw.length; i++) {
            const char = raw[i];

            if (currentQuote) {
                result += char;
                if (escape) {
                    escape = false;
                    continue;
                }
                if (char === '\\') {
                    escape = true;
                    continue;
                }
                if (char === currentQuote) {
                    currentQuote = null;
                }
                continue;
            }

            if (char === '"' || char === "'") {
                currentQuote = char;
                result += char;
                expectingValue = false;
                continue;
            }

            if (expectingValue && /\S/.test(char) && !['{', '[', '}', ']', ','].includes(char)) {
                let end = i + 1;
                while (end < raw.length && ![',', '}', ']'].includes(raw[end])) {
                    end += 1;
                }
                result += normalizeBareValue(raw.slice(i, end));
                expectingValue = false;
                i = end - 1;
                continue;
            }

            if (char === '{') {
                stack.push('object');
                expectingValue = false;
                result += char;
                continue;
            }

            if (char === '[') {
                stack.push('array');
                expectingValue = true;
                result += char;
                continue;
            }

            if (char === '}' || char === ']') {
                stack.pop();
                expectingValue = false;
                result += char;
                continue;
            }

            result += char;

            if (char === ':') {
                expectingValue = true;
            } else if (char === ',') {
                expectingValue = stack[stack.length - 1] === 'array';
            } else if (expectingValue && /\S/.test(char)) {
                expectingValue = false;
            }
        }

        return result;
    }

    private extractFirstJsonValue(raw: string): string | null {
        const objectStart = raw.indexOf('{');
        const arrayStart = raw.indexOf('[');
        const startCandidates = [objectStart, arrayStart].filter((index) => index >= 0);
        const start = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;
        if (start === -1) {
            return null;
        }

        const stack: string[] = [];
        let currentQuote: '"' | "'" | null = null;
        let escape = false;

        for (let i = start; i < raw.length; i++) {
            const char = raw[i];

            if (escape) {
                escape = false;
                continue;
            }

            if (char === '\\') {
                escape = true;
                continue;
            }

            if (currentQuote) {
                if (char === currentQuote) {
                    currentQuote = null;
                }
                continue;
            }

            if (char === '"' || char === "'") {
                currentQuote = char;
                continue;
            }

            if (char === '{') {
                stack.push('}');
                continue;
            }
            if (char === '[') {
                stack.push(']');
                continue;
            }
            if (char === '}' || char === ']') {
                if (stack[stack.length - 1] === char) {
                    stack.pop();
                }
                if (stack.length === 0) {
                    return raw.slice(start, i + 1);
                }
            }
        }

        const suffix = raw.slice(start);
        let repaired = suffix;
        if (currentQuote) {
            repaired += currentQuote;
        }
        while (stack.length > 0) {
            repaired += stack.pop();
        }
        return repaired.length > 0 ? repaired : null;
    }
}
