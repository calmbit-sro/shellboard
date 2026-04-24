import type {
  MosaicBranch,
  MosaicDirection,
  MosaicNode,
  MosaicParent,
} from "react-mosaic-component";

export type Node = MosaicNode<string>;
export type Parent = MosaicParent<string>;

export function isLeaf(node: Node): node is string {
  return typeof node === "string";
}

export function collectLeaves(node: Node): string[] {
  if (isLeaf(node)) return [node];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function replaceLeaf(
  node: Node,
  leafId: string,
  replacement: Node,
): Node {
  if (isLeaf(node)) return node === leafId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, leafId, replacement),
    second: replaceLeaf(node.second, leafId, replacement),
  };
}

/**
 * Remove the given leaf. The parent node collapses to the sibling subtree.
 * Returns null if the removal empties the whole tree.
 */
export function removeLeaf(node: Node, leafId: string): Node | null {
  if (isLeaf(node)) return node === leafId ? null : node;
  const first = removeLeaf(node.first, leafId);
  const second = removeLeaf(node.second, leafId);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

export function firstLeafOf(node: Node): string {
  return isLeaf(node) ? node : firstLeafOf(node.first);
}

/**
 * Given a leaf, return the first leaf of its sibling subtree — the natural
 * focus target after the leaf is removed.
 */
export function findSiblingLeaf(node: Node, leafId: string): string | null {
  if (isLeaf(node)) return null;
  if (isLeaf(node.first) && node.first === leafId)
    return firstLeafOf(node.second);
  if (isLeaf(node.second) && node.second === leafId)
    return firstLeafOf(node.first);
  const inFirst = findSiblingLeaf(node.first, leafId);
  if (inFirst !== null) return inFirst;
  return findSiblingLeaf(node.second, leafId);
}

type PathStep = { parent: Parent; branch: MosaicBranch };

function pathTo(node: Node, leafId: string): PathStep[] | null {
  if (isLeaf(node)) return node === leafId ? [] : null;
  const l = pathTo(node.first, leafId);
  if (l !== null) return [{ parent: node, branch: "first" }, ...l];
  const r = pathTo(node.second, leafId);
  if (r !== null) return [{ parent: node, branch: "second" }, ...r];
  return null;
}

/**
 * Descend into a subtree and pick the leaf closest to the "entry" side.
 * When the subtree's direction matches, follow the entry side;
 * otherwise the choice is spatially ambiguous, so fall to 'first' for stability.
 */
function extremeLeaf(
  node: Node,
  direction: MosaicDirection,
  entrySide: MosaicBranch,
): string {
  if (isLeaf(node)) return node;
  if (node.direction === direction) {
    return extremeLeaf(node[entrySide], direction, entrySide);
  }
  return extremeLeaf(node.first, direction, entrySide);
}

export type FocusDir = "left" | "right" | "up" | "down";

/**
 * Tree-based directional focus: walk from the focused leaf up to the root,
 * find the first ancestor that splits along the requested axis such that we
 * came from the side we need to leave. Then descend into the other side and
 * pick the leaf closest to the divider we just crossed.
 */
export function findNeighborLeaf(
  tree: Node,
  leafId: string,
  dir: FocusDir,
): string | null {
  const targetDirection: MosaicDirection =
    dir === "left" || dir === "right" ? "row" : "column";
  const fromSide: MosaicBranch =
    dir === "right" || dir === "down" ? "first" : "second";
  const targetSide: MosaicBranch = fromSide === "first" ? "second" : "first";

  const path = pathTo(tree, leafId);
  if (path === null) return null;

  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    if (
      step.parent.direction === targetDirection &&
      step.branch === fromSide
    ) {
      return extremeLeaf(step.parent[targetSide], targetDirection, fromSide);
    }
  }
  return null;
}
