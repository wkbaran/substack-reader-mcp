/** Parse "7d" / "48h" / "2w" or an ISO date into a Date. */
export function parseSince(since: string | undefined, now = Date.now()): Date | undefined {
  if (!since) return undefined;
  const rel = since.trim().match(/^(\d+)\s*([hdw])$/i);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]!.toLowerCase() as "h" | "d" | "w"];
    return new Date(now - Number(rel[1]) * unit);
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Couldn't understand since="${since}". Use an ISO date or e.g. "7d".`);
  return new Date(t);
}

/** ISO time without milliseconds: 2026-10-02T12:00:24Z. */
export function isoSeconds(d: Date | number): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clean(s: string): string {
  // Newer ICU puts a narrow no-break space before AM/PM.
  return s.replace(/[  ]/g, " ");
}

/** "Fri, Oct 2, 6:00 AM MDT" in the given IANA time zone. */
export function formatLocal(when: string | Date, timeZone: string): string {
  const d = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return String(when);
  // dateStyle can't be combined with timeZoneName, so spell the fields out.
  return clean(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d),
  );
}

/** "Oct 2" in the given time zone. */
export function formatDay(when: string | Date, timeZone: string): string {
  const d = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return String(when);
  return clean(new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d));
}

/** "Oct 2, 6:00 AM" in the given time zone (for post listings). */
export function formatShort(when: string | Date, timeZone: string): string {
  const d = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return String(when);
  return clean(new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d));
}
