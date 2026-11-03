#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { svgFooter, svgHeader, text, theme } from "./plot-lib.js";

const width = 1200;
const palette = {
  good: { fill: theme.passFill, stroke: theme.passStroke, title: theme.accent },
  neutral: { fill: theme.neutralFill, stroke: theme.slateBar, title: theme.text },
  warn: { fill: theme.failFill, stroke: theme.failStroke, title: theme.fail },
};

function node(x, y, w, h, item) {
  const tone = palette[item.kind] ?? palette.neutral;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${tone.fill}" stroke="${tone.stroke}" stroke-opacity="0.7" stroke-width="1.5" />`,
    text(x + w / 2, y + 28, item.label, {
      anchor: "middle",
      fill: tone.title,
      size: 15,
      weight: "650",
    }),
    text(x + w / 2, y + 47, item.sub, { anchor: "middle", fill: theme.subtitle, size: 11.5 }),
  ];
  if (item.tag) {
    const tagColor = item.kind === "warn" ? theme.fail : theme.accent;
    const tagFill = item.kind === "warn" ? theme.failFill : theme.passFill;
    const tagWidth = 12 + item.tag.length * 6.6;
    const tagX = x + w / 2 - tagWidth / 2;
    parts.push(
      `<rect x="${tagX.toFixed(1)}" y="${y + h + 10}" width="${tagWidth.toFixed(1)}" height="22" rx="11" fill="${tagFill}" stroke="${tagColor}" stroke-opacity="0.5" />`,
      text(x + w / 2, y + h + 25, item.tag, {
        anchor: "middle",
        fill: tagColor,
        size: 11,
        weight: "600",
      })
    );
  }
  return parts.join("\n");
}

function arrow(x1, x2, y) {
  const tip = x2 - 2;
  return [
    `<line x1="${x1 + 2}" y1="${y}" x2="${tip - 7}" y2="${y}" stroke="${theme.muted}" stroke-width="2" />`,
    `<path d="M${tip - 7},${y - 5} L${tip},${y} L${tip - 7},${y + 5} Z" fill="${theme.muted}" />`,
  ].join("\n");
}

function bracket(x1, x2, y, label, color) {
  const mid = (x1 + x2) / 2;
  return [
    `<path d="M${x1},${y} L${x1},${y + 10} L${x2},${y + 10} L${x2},${y}" fill="none" stroke="${color}" stroke-opacity="0.6" stroke-width="1.5" />`,
    `<line x1="${mid}" y1="${y + 10}" x2="${mid}" y2="${y + 18}" stroke="${color}" stroke-opacity="0.6" stroke-width="1.5" />`,
    text(mid, y + 34, label, { anchor: "middle", fill: color, size: 12.5, weight: "600" }),
  ].join("\n");
}

function callout(y, label, color, fill) {
  const x = 40;
  const w = width - 80;
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="48" rx="10" fill="${fill}" stroke="${color}" stroke-opacity="0.45" />`,
    `<rect x="${x}" y="${y}" width="5" height="48" rx="2.5" fill="${color}" />`,
    text(x + 22, y + 29, label, { fill: theme.text, size: 13.5, weight: "500" }),
  ].join("\n");
}

function renderFlow(config) {
  const steps = config.steps;
  const count = steps.length;
  const marginX = 40;
  const nodeW = 150;
  const nodeH = 60;
  const usable = width - marginX * 2;
  const gap = (usable - nodeW * count) / (count - 1);
  const nodeY = 132;
  const bracketY = nodeY + nodeH + 44;
  const calloutY = bracketY + 56;
  const height = calloutY + 48 + 40;
  const xFor = (index) => marginX + index * (nodeW + gap);
  const parts = [
    svgHeader(width, height, config.title),
    `<rect width="100%" height="100%" rx="14" fill="${theme.bg}" />`,
    text(marginX, 52, config.title, { fill: theme.title, size: 22, weight: "700" }),
    text(marginX, 78, config.subtitle, { fill: theme.subtitle, size: 13 }),
  ];
  for (let index = 0; index < count - 1; index += 1) {
    parts.push(arrow(xFor(index) + nodeW, xFor(index + 1), nodeY + nodeH / 2));
  }
  for (const [index, step] of steps.entries()) {
    parts.push(node(xFor(index), nodeY, nodeW, nodeH, step));
  }
  parts.push(
    bracket(
      xFor(config.bracket.from),
      xFor(config.bracket.to) + nodeW,
      bracketY,
      config.bracket.label,
      config.bracket.color
    ),
    callout(calloutY, config.callout.label, config.callout.color, config.callout.fill),
    text(marginX, height - 18, config.footer, { fill: theme.muted, size: 11 }),
    svgFooter()
  );
  return parts.join("\n");
}

const legacy = renderFlow({
  bracket: {
    color: theme.failStroke,
    from: 1,
    label: "Needs a running PostgreSQL at every step",
    to: 5,
  },
  callout: {
    color: theme.failStroke,
    fill: theme.failFill,
    label:
      "RLS policies are diffed by name — a tightened USING predicate can be dropped silently, shipping a tenant-isolation hole.",
  },
  footer: "The declarative promise, today: every step pays for database infrastructure.",
  steps: [
    { kind: "neutral", label: "Edit schema", sub: "SQL files" },
    { kind: "warn", label: "Spin up", sub: "shadow database", tag: "Docker" },
    { kind: "warn", label: "Replay schema", sub: "into the shadow DB", tag: "minutes at scale" },
    { kind: "neutral", label: "Diff", sub: "→ migration" },
    { kind: "warn", label: "Apply", sub: "to the database", tag: "before types" },
    { kind: "warn", label: "Introspect", sub: "→ TypeScript", tag: "types lag the editor" },
  ],
  subtitle: "Diff engines and type generators both need a database that already has your change.",
  title: "The declarative workflow today",
});

const supaschema = renderFlow({
  bracket: {
    color: theme.passStroke,
    from: 1,
    label: "No Docker · no shadow database · no introspection",
    to: 4,
  },
  callout: {
    color: theme.passStroke,
    fill: theme.passFill,
    label:
      "Policy bodies are compared structurally, so the tenant-isolation regression every CLI engine misses is caught before it merges.",
  },
  footer: "supaschema: PostgreSQL's own parser ships in the package, so no step needs a database.",
  steps: [
    { kind: "neutral", label: "Edit schema", sub: "SQL files" },
    { kind: "good", label: "Parse", sub: "embedded Postgres", tag: "no database" },
    { kind: "good", label: "Compare ASTs", sub: "policy bodies too", tag: "catches RLS drift" },
    { kind: "good", label: "Render", sub: "guarded migration", tag: "replay-safe" },
    { kind: "good", label: "Types + Zod", sub: "same command", tag: "no apply first" },
    { kind: "neutral", label: "Your runner", sub: "applies the SQL" },
  ],
  subtitle:
    "The parser already knows every table, column, type, and policy — so nothing waits on a database.",
  title: "The supaschema workflow",
});

const outDir = resolve("docs/public/images/concepts");
await mkdir(outDir, { recursive: true });
const legacyPath = resolve(outDir, "legacy-flow.svg");
const supaschemaPath = resolve(outDir, "supaschema-flow.svg");
await writeFile(legacyPath, legacy, "utf8");
await writeFile(supaschemaPath, supaschema, "utf8");
process.stdout.write(`${legacyPath}\n${supaschemaPath}\n`);
