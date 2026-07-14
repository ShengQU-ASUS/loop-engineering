const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|token|password|cookie|private[-_]?key)/i;
const INLINE_SECRET = /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+\/-]{16,})\b/gi;

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

export function redactText(input: string): RedactionResult<string> {
  let redacted = false;
  const value = input.replace(INLINE_SECRET, () => {
    redacted = true;
    return "[REDACTED]";
  });
  return { value, redacted };
}

export function redactValue<T>(input: T): RedactionResult<T> {
  let redacted = false;

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactText(value);
      redacted ||= result.redacted;
      return result.value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => {
        if (SENSITIVE_KEY.test(key)) {
          redacted = true;
          return [key, "[REDACTED]"];
        }
        return [key, visit(child)];
      }));
    }
    return value;
  };

  return { value: visit(input) as T, redacted };
}
