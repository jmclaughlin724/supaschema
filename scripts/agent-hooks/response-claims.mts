import { currentTurnState, type EvidenceEntry, type SessionState } from "./state.mts";

const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

export function tokenize(text: unknown): string[] {
  const words: string[] = [];
  for (const { segment, isWordLike } of wordSegmenter.segment(String(text ?? ""))) {
    if (isWordLike) {
      words.push(segment.toLowerCase());
    }
  }
  return words;
}

export function claimedVerificationDomains(message: unknown): string[] {
  const claims = new Set<string>();
  for (const clause of splitClauses(message)) {
    for (const domain of parseSuccessClaims(tokenize(clause))) {
      claims.add(domain);
    }
  }
  return [...claims].sort();
}

export function verificationClaimConflict(
  message: unknown,
  state: SessionState
): { id: string; message: string } | undefined {
  const claims = claimedVerificationDomains(message);
  if (claims.length === 0) {
    return;
  }
  const evidence = currentTurnState(state).evidence;
  const contradicted = claims.filter((domain) => unresolvedFailure(evidence, domain));
  if (contradicted.length === 0) {
    return;
  }
  return {
    id: "verification-claim-conflict",
    message: `The response claims successful verification while unresolved failure evidence remains for: ${contradicted.join(", ")}. Report the failure honestly, record a later successful result, or remove the success claim.`,
  };
}

function parseSuccessClaims(tokens: readonly string[]): Set<string> {
  const claims = new Set<string>();
  for (let predicateIndex = 0; predicateIndex < tokens.length; predicateIndex += 1) {
    if (
      !successPredicate(tokens, predicateIndex) ||
      describesHistoricalVerification(tokens, predicateIndex)
    ) {
      continue;
    }
    const found = domainsBeforePredicate(tokens, predicateIndex);
    for (const domain of found) {
      claims.add(domain);
    }
  }
  return claims;
}

function describesHistoricalVerification(
  tokens: readonly string[],
  predicateIndex: number
): boolean {
  let startIndex = 0;
  for (let index = predicateIndex - 1; index >= 0; index -= 1) {
    if (temporalAssertionBoundary(tokens[index])) {
      startIndex = index + 1;
      break;
    }
  }
  let endIndex = tokens.length;
  for (let index = predicateIndex + 1; index < tokens.length; index += 1) {
    if (temporalAssertionBoundary(tokens[index])) {
      endIndex = index;
      break;
    }
  }
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (
      historicalMarker(token) &&
      historicalMarkerDescribesPredicate(tokens, index, predicateIndex)
    ) {
      return true;
    }
    if (token === "baseline" && index !== predicateIndex) {
      return true;
    }
  }
  return false;
}

function temporalAssertionBoundary(token: string): boolean {
  switch (token) {
    case "but":
    case "currently":
    case "however":
    case "now":
    case "still":
    case "today":
    case "yet":
      return true;
    default:
      return false;
  }
}

function historicalMarker(token: string): boolean {
  switch (token) {
    case "before":
    case "earlier":
    case "formerly":
    case "previously":
      return true;
    default:
      return false;
  }
}

function historicalMarkerDescribesPredicate(
  tokens: readonly string[],
  markerIndex: number,
  predicateIndex: number
): boolean {
  if (markerIndex < predicateIndex) {
    for (let index = markerIndex + 1; index < predicateIndex; index += 1) {
      if (negatesClaim(tokens[index])) {
        return false;
      }
    }
    return true;
  }
  for (let index = predicateIndex + 1; index < markerIndex; index += 1) {
    switch (tokens[index]) {
      case "after":
      case "despite":
      case "following":
        return false;
      default:
        break;
    }
  }
  return true;
}

function domainsBeforePredicate(tokens: readonly string[], predicateIndex: number): Set<string> {
  const claims = new Set<string>();
  let sawDomain = false;
  let coordinated = false;
  for (let index = predicateIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (negatesClaim(token)) {
      return new Set<string>();
    }
    const domain = verificationDomain(token);
    if (domain) {
      if (!sawDomain || coordinated) {
        claims.add(domain);
      }
      sawDomain = true;
      coordinated = false;
      continue;
    }
    if (sawDomain && (token === "and" || token === "or")) {
      coordinated = true;
      continue;
    }
    if (claimJoiner(token)) {
      continue;
    }
    if (associationBoundary(token)) {
      return new Set<string>();
    }
    break;
  }
  return claims;
}

function verificationDomain(token: string): string {
  switch (token) {
    case "build":
    case "builds":
      return "build";
    case "ci":
    case "github":
      return "github-checks";
    case "docs":
    case "documentation":
      return "docs";
    case "guard":
    case "guards":
      return "guard";
    case "lint":
    case "lints":
      return "lint";
    case "package":
    case "packages":
    case "tarball":
      return "package";
    case "sync":
    case "synced":
      return "sync";
    case "test":
    case "tested":
    case "tests":
    case "vitest":
      return "test";
    case "typecheck":
    case "typechecks":
      return "typecheck";
    default:
      return "";
  }
}

function successPredicate(tokens: readonly string[], index: number): boolean {
  switch (tokens[index]) {
    case "green":
    case "pass":
    case "passed":
    case "passes":
    case "passing":
    case "succeed":
    case "succeeded":
    case "succeeds":
    case "success":
    case "successful":
    case "verified":
      return true;
    case "completed":
      return tokens[index - 1] === "successfully";
    default:
      return false;
  }
}

function negatesClaim(token: string): boolean {
  switch (token) {
    case "cannot":
    case "failed":
    case "failing":
    case "never":
    case "no":
    case "not":
    case "without":
      return true;
    default:
      return false;
  }
}

function claimJoiner(token: string): boolean {
  switch (token) {
    case "a":
    case "all":
    case "already":
    case "an":
    case "are":
    case "both":
    case "has":
    case "have":
    case "is":
    case "now":
    case "successfully":
    case "the":
    case "was":
    case "were":
      return true;
    default:
      return false;
  }
}

function associationBoundary(token: string): boolean {
  switch (token) {
    case "about":
    case "concerning":
    case "describing":
    case "discussing":
    case "for":
    case "regarding":
    case "reviewing":
    case "why":
      return true;
    default:
      return false;
  }
}

function splitClauses(text: unknown): string[] {
  const clauses: string[] = [];
  let current = "";
  for (const { segment, isWordLike } of wordSegmenter.segment(String(text ?? ""))) {
    if (isWordLike || !clauseBoundary(segment)) {
      current += segment;
      continue;
    }
    if (current.trim() && segment !== "?") {
      clauses.push(current.trim());
    }
    current = "";
  }
  if (current.trim()) {
    clauses.push(current.trim());
  }
  return clauses;
}

function clauseBoundary(value: string): boolean {
  return (
    value === "." ||
    value === "," ||
    value === "\n" ||
    value === ";" ||
    value === "!" ||
    value === "?" ||
    value === "•"
  );
}

function unresolvedFailure(evidence: readonly EvidenceEntry[], domain: string): boolean {
  let latestOutcome = "";
  for (const item of evidence) {
    if (item.domain === domain) {
      latestOutcome = item.outcome;
    }
  }
  return latestOutcome === "failure";
}
