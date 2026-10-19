/** "pick, pack  slam" -> ["pick", "pack", "slam"]: split on commas/semicolons/whitespace, drop empties and duplicates. */
export function parseCapabilities(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((c) => c.trim()).filter((c) => c !== ""))];
}
