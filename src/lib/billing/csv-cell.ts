export function csvCell(value: string | number | null): string {
  if (value === null) return "\"\"";
  let text = String(value);
  // A numeric negative is data, not a spreadsheet formula. Text beginning
  // with formula operators is escaped before it is exported.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `\u0027${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
