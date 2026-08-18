export async function loadLeaf(): Promise<string> {
  const mod = await import('./leaf.ts');
  return mod.leafFn();
}
