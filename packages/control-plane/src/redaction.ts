const INLINE_SECRET = /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|(?:AKIA|ASIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+\/-]{16,})\b/gi;
const URL_CREDENTIAL = /\b((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?|mssql|sqlserver):\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;
const ASSIGNMENT_KEY = String.raw`(?:(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:key(?:[_-]?id)?|token|secret|password)|_?(?:apiKey|accessKey|authToken|sessionToken|clientSecret|dbPassword|databasePassword))`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`((?:"${ASSIGNMENT_KEY}"|'${ASSIGNMENT_KEY}'|\b${ASSIGNMENT_KEY}\b)\s*[:=]\s*)("[^"\r\n]+"|'[^'\r\n]+'|\[REDACTED\]|[^\s,;}\])"']+)`,
  "gi",
);

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

  return /(?:^|[_-])(?:authorization|cookie|password|secret|token)$/.test(normalized)
    || /(?:^|[_-])(?:api|private|access|secret)[_-]key(?:[_-]?id)?$/.test(normalized)
    || /^(?:authorization|cookie)[_-]header$/.test(normalized);
}

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

export function redactText(input: string): RedactionResult<string> {
  let redacted = false;
  let value = input.replace(URL_CREDENTIAL, (_match, prefix: string, _password: string, suffix: string) => {
    redacted = true;
    return `${prefix}[REDACTED]${suffix}`;
  });
  value = value.replace(INLINE_SECRET, () => {
    redacted = true;
    return "[REDACTED]";
  });
  value = value.replace(SECRET_ASSIGNMENT, (match: string, prefix: string, secret: string) => {
    const quote = secret[0];
    const unquotedSecret = quote === '"' || quote === "'" ? secret.slice(1, -1) : secret;
    if (unquotedSecret === "[REDACTED]") return match;

    redacted = true;
    const replacement = quote === '"' || quote === "'"
      ? `${quote}[REDACTED]${quote}`
      : "[REDACTED]";
    return `${prefix}${replacement}`;
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
        if (isSensitiveKey(key)) {
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
