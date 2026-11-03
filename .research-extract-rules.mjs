import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const rulesDir = ".claude/rules";
const files = readdirSync(rulesDir, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".md"))
  .map((d) => d.name)
  .sort();

const results = [];
for (const file of files) {
  const path = join(rulesDir, file);
  const lines = readFileSync(path, "utf8").split("\n");
  const closing = lines.indexOf("---", 1);
  if (lines[0] !== "---" || closing === -1) {
    results.push({ file, path, error: "NO_FRONTMATTER" });
    continue;
  }
  let fm;
  try {
    fm = parseYaml(lines.slice(1, closing).join("\n"));
  } catch {
    results.push({ file, path, error: "YAML_PARSE_ERROR" });
    continue;
  }
  const paths = fm?.paths ?? null;
  const enforcementType = fm?.enforcement?.type ?? null;
  const description = fm?.description ?? null;
  results.push({ file, path, paths, enforcementType, description });
}

console.log(JSON.stringify(results, null, 2));
