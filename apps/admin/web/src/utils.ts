export const relativeTime = (date: string | null): string => {
  if (!date) return "Never";
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
};

export const shortDate = (date: string | null): string => date
  ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date))
  : "—";

export const duration = (ms: number | null): string => {
  if (ms === null) return "In progress";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

export const bytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
};

export const percent = (used: number, limit: number): number => limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
export const compactId = (value: string): string => value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value;
export const titleCase = (value: string): string => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
