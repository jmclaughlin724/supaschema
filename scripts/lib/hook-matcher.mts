const matchAllSuffix = [".", "*"].join("");
const escapedDot = ["\\", "."].join("");

export function hookMatcherMatchesTool(matcher: unknown, toolName: unknown): boolean {
  if (typeof matcher !== "string" || typeof toolName !== "string") {
    return false;
  }
  return matcher.split("|").some((alternative) => {
    if (alternative === matchAllSuffix) {
      return true;
    }
    if (alternative.endsWith(matchAllSuffix)) {
      return toolName.startsWith(alternative.slice(0, -matchAllSuffix.length));
    }
    return alternative.split(escapedDot).join(".") === toolName;
  });
}
