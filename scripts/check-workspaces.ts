import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { ROOT } from "./utils/scripts.constants";

/** Production imports may cross workspace boundaries only through declared package exports. */
const roots = ["apps/api", "apps/bot", "apps/web", "packages/contracts", "packages/api-client"];
const problems: string[] = [];
const project = new Project({ skipAddingFilesFromTsConfig: true });
function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  });
}
for (const workspace of roots) {
  const root = path.join(ROOT, workspace);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const file of walk(path.join(root, "src"))) {
    const source = project.addSourceFileAtPath(file);
    const imports = [
      ...source.getImportDeclarations().map((entry) => entry.getModuleSpecifierValue()),
      ...source
        .getExportDeclarations()
        .map((entry) => entry.getModuleSpecifierValue())
        .filter((entry): entry is string => Boolean(entry)),
      ...source
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((entry) => ["import", "require"].includes(entry.getExpression().getText()))
        .flatMap((entry) =>
          entry
            .getArguments()
            .filter((argument) => argument.isKind(SyntaxKind.StringLiteral))
            .map((argument) => argument.getLiteralText()),
        ),
    ];
    for (const imported of imports) {
      if (imported.startsWith(".")) {
        const target = path.resolve(path.dirname(file), imported);
        if (!target.startsWith(`${root}${path.sep}`)) problems.push(`${path.relative(ROOT, file)} imports ${imported}`);
      } else if (!imported.startsWith("node:") && !imported.startsWith("~/")) {
        const name = imported.startsWith("@") ? imported.split("/").slice(0, 2).join("/") : imported.split("/")[0];
        if (!dependencies[name] && !dependencies[`@types/${name}`])
          problems.push(`${path.relative(ROOT, file)} uses undeclared ${name}`);
      }
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.info("Production workspace imports and dependency declarations passed.");
