import { validateCollectionTarget, type CollectionTarget } from "../../src/index.js";

/** Host code written against the 2.9.8 surface, reading the role form validateCollectionTarget returned
 * there. `npm run typecheck` compiles this file, so a return type that drops `root` fails there. */
export function describeCollection(collection: CollectionTarget): string {
  const checked = validateCollectionTarget({ collection });
  return `${checked.root.role}:${checked.root.name}:${checked.itemRole}:${checked.target.role}`;
}

export function authoredRootName(): string | undefined {
  return validateCollectionTarget({ collection: {
    root: { role: "list", name: "Results" }, itemRole: "listitem", target: { role: "link" }, order: "dom", index: 0,
  } }).root.name;
}
