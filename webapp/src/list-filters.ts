export type FilterDef = [label: string, predicate: (item: any) => boolean, tip?: string, group?: string];

/** Independent facets intersect; selections within a named group form a union. */
export function matchesFilters(item: any, definitions: FilterDef[], selected: Set<string>): boolean {
  const groups = new Map<string, boolean>();
  for (const [label, predicate, , group] of definitions) {
    if (!selected.has(label)) continue;
    const matches = predicate(item);
    if (!group && !matches) return false;
    if (group) groups.set(group, (groups.get(group) ?? false) || matches);
  }
  return [...groups.values()].every(Boolean);
}

export function episodeFilters(items: {episode?: {name?: string | null} | null}[]): FilterDef[] {
  const names = [...new Set(items.map(item => item.episode?.name).filter((name): name is string => !!name))].sort((a,b)=>a.localeCompare(b));
  if (!names.length) return [];
  const result: FilterDef[] = names.map(name => [`Episode: ${name}`, item => item.episode?.name === name,
    'Show rooms in this episode. Selecting several episodes includes any of them.', 'episode']);
  if (items.some(item => !item.episode?.name)) result.push(['Episode: Unknown', item => !item.episode?.name,
    'Rooms without a recovered episode name.', 'episode']);
  return result;
}
