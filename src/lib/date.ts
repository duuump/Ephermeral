// dd.mm.yy in Polish local time, e.g. 08.10.26
export function fmtDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.day}.${p.month}.${p.year}`;
}
