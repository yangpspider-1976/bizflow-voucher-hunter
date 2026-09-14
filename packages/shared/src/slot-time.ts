/** A slot stays available until its end time in the venue's timezone. */
export function slotHasEnded(
  slot: { date: string; endTime: string; timezone: string },
  now = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: slot.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const stamp = `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}`;
  const endTime = slot.endTime.length === 5 ? `${slot.endTime}:00` : slot.endTime;
  return stamp >= `${slot.date}T${endTime}`;
}
