import fs from "node:fs";
import path from "node:path";
import { agentSurfaceManifest } from "./agent-surface-manifest.mts";

const docsBaseUrl = "https://supaschema.com/docs";
const bundleDocsSurface = agentSurfaceManifest.bundleDocs;
const excludedSourceDirectories = new Set(bundleDocsSurface.excludedSourceDirectories);

export function bundleDocsFiles(root: string): Map<string, Buffer> {
  const docsRoot = path.join(root, "docs");
  const sourceFiles = listMdxFiles(docsRoot);
  const files = new Map<string, Buffer>();

  for (const sourceFile of sourceFiles) {
    files.set(`docs/${sourceFile}`, fs.readFileSync(path.join(docsRoot, sourceFile)));
  }

  const entries = sourceFiles.map((sourceFile) => {
    const route = sourceFile.slice(0, -".mdx".length);
    return `- [agent-bundle/docs/${sourceFile}](${docsBaseUrl}/${route})`;
  });
  files.set(
    "docs/index.md",
    Buffer.from(["# Supaschema Documentation", "", ...entries, ""].join("\n"), "utf8")
  );

  return files;
}

function listMdxFiles(root: string): string[] {
  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`documentation source must be a regular directory: ${root}`);
  }
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`documentation source contains a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) {
        if (
          excludedSourceDirectories.has(entry.name) ||
          (bundleDocsSurface.excludeHiddenSourceDirectories && entry.name.startsWith("."))
        ) {
          continue;
        }
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };

  visit(root);
  return files.sort((left, right) => Number(left > right) - Number(left < right));
}
