import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { ROOT } from "./utils/scripts.constants";

interface HandlerGroup {
  label: string;
  modulePath: string;
  decoratorNames: string[];
  fileSuffix: string;
  classSuffix: string;
}

const groups: HandlerGroup[] = [
  {
    label: "command",
    modulePath: path.join(ROOT, "src/commands/commands.module.ts"),
    decoratorNames: ["SlashCommand", "Subcommand"],
    fileSuffix: ".command.ts",
    classSuffix: "Command",
  },
  {
    label: "listener",
    modulePath: path.join(ROOT, "src/listeners/listeners.module.ts"),
    decoratorNames: ["On", "Once"],
    fileSuffix: ".listener.ts",
    classSuffix: "Listener",
  },
];

groups.push({
  label: "component",
  modulePath: path.join(ROOT, "src/components/components.module.ts"),
  decoratorNames: ["Button", "StringSelect", "Modal", "UserSelect", "RoleSelect", "ChannelSelect"],
  fileSuffix: ".component.ts",
  classSuffix: "Component",
});
groups.push(
  ...groups.map((group) => ({
    ...group,
    modulePath: group.modulePath.replace(path.join(ROOT, "src"), path.join(ROOT, "apps/bot/src")),
  })),
);

const project = new Project({ tsConfigFilePath: path.join(ROOT, "tsconfig.json") });
const errors: string[] = [];

for (const group of groups) {
  validateGroup(group);
}

if (errors.length > 0) {
  console.error("Handler validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.info("Handler validation passed.");

function validateGroup(group: HandlerGroup) {
  if (!fs.existsSync(group.modulePath)) {
    errors.push(`${group.label} module is missing: ${relative(group.modulePath)}`);
    return;
  }

  const moduleSource = fs.readFileSync(group.modulePath, "utf8");
  const imports = [
    ...moduleSource.matchAll(/import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+["'](\.\/handlers\/[^"']+)["']/g),
  ].map(([, className, importPath]) => ({ className, importPath }));
  const handlersMatch = moduleSource.match(/const HANDLERS:\s*Provider\[\]\s*=\s*\[([\s\S]*?)\];/);

  if (!handlersMatch) {
    errors.push(`${relative(group.modulePath)} is missing its HANDLERS array`);
    return;
  }

  const handlerEntries = handlersMatch[1].match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  const importNames = imports.map(({ className }) => className);

  for (const className of new Set(handlerEntries)) {
    if (!importNames.includes(className)) {
      errors.push(`${relative(group.modulePath)} registers ${className} without importing it`);
    }
  }

  for (const className of new Set(importNames)) {
    const occurrences = handlerEntries.filter((entry) => entry === className).length;
    if (occurrences === 0) {
      errors.push(`${relative(group.modulePath)} imports ${className} but does not register it`);
    } else if (occurrences > 1) {
      errors.push(`${relative(group.modulePath)} registers ${className} more than once`);
    }
  }

  const commandNames = new Map<string, string>();
  if (group.label === "command") {
    const optionalModule = path.resolve(
      path.dirname(group.modulePath),
      "../patron-link/patron-link-commands.module.ts",
    );
    const optionalHandler = path.resolve(path.dirname(optionalModule), "patron-link.command.ts");
    if (fs.existsSync(optionalModule) && fs.existsSync(optionalHandler)) {
      const module = project.addSourceFileAtPath(optionalModule);
      if (!module.getText().match(/providers:\s*\[PatronLinkCommand\]/))
        errors.push(`${relative(optionalModule)} must register PatronLinkCommand`);
      const source = project.addSourceFileAtPath(optionalHandler);
      const names = source
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((entry) => entry.getExpression().getText() === "createCommandGroupDecorator")
        .map((entry) => entry.getText().match(/\bname\s*:\s*["']([^"']+)["']/)?.[1]);
      for (const name of names) if (name) commandNames.set(name, relative(optionalHandler));
    }
  }
  for (const { className, importPath } of imports) {
    const handlerPath = path.resolve(path.dirname(group.modulePath), `${importPath}.ts`);
    if (!fs.existsSync(handlerPath)) {
      errors.push(`${relative(group.modulePath)} imports missing file ${relative(handlerPath)}`);
      continue;
    }

    const sourceFile = project.addSourceFileAtPath(handlerPath);
    if (!sourceFile.getClass(className)) {
      errors.push(`${relative(handlerPath)} does not export class ${className}`);
    }

    const decorators = sourceFile
      .getDescendantsOfKind(SyntaxKind.Decorator)
      .filter((decorator) => group.decoratorNames.includes(decorator.getName()));
    if (decorators.length === 0) {
      errors.push(`${relative(handlerPath)} has no ${group.decoratorNames.join(" or ")} decorator`);
    }

    if (group.label === "command") {
      const expressions = [
        ...decorators.filter((item) => item.getName() === "SlashCommand").map((item) => item.getText()),
        ...sourceFile
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .filter((item) => item.getExpression().getText() === "createCommandGroupDecorator")
          .map((item) => item.getText()),
      ];
      for (const expression of expressions) {
        const name = expression.match(/\bname\s*:\s*["']([^"']+)["']/)?.[1];
        if (!name) continue;
        const previous = commandNames.get(name);
        if (previous) {
          errors.push(`duplicate slash command name "${name}" in ${previous} and ${relative(handlerPath)}`);
        } else {
          commandNames.set(name, relative(handlerPath));
        }
      }
    }
  }
}

function relative(filePath: string) {
  return path.relative(ROOT, filePath);
}
