// Resolve the stored default only when the complete visual-owner header is
// present. Null placeholders represent computed selections and stay unknown.
type Field = { op: number; kind: string; node?: any; raw?: Uint8Array };
export type StaticAppearance = { op: number; controllers: number[] };

export function readAppearanceControllers(
  node: any, deref: (node: any) => any, symbol: (index: number) => string | undefined,
): number[] | null {
  const controllers = new Set<number>();
  const visit = (node: any, depth = 0): boolean => {
    if (depth > 16) return false;
    const value = deref(node);
    if (value?.tag === 0x26 && Number.isInteger(value.value) && value.value >= 0) {
      controllers.add(value.value);
      return true;
    }
    if (value?.tag === 0x0f && symbol(value.value) === '$none') return true;
    if (value?.tag === 0x20 && Array.isArray(value.values)) return value.values.every((n: any) => visit(n, depth + 1));
    return false;
  };
  return visit(node) ? [...controllers] : null;
}

export function readStaticAppearance(
  fields: Field[], deref: (node: any) => any, symbol: (index: number) => string | undefined,
): StaticAppearance | null {
  const generic = new Map(fields.filter(f => f.kind === 'G').map(f => [f.op, deref(f.node)]));
  const fixed = fields.find(f => f.kind === 'F' && f.raw?.length === 1);
  if (!fixed) return null;
  const at = (op: number) => generic.get(op);
  let header = false;
  for (const op of generic.keys()) {
    const dimensions = [at(op), at(op + 1), at(op + 2)];
    const box = at(op + 4);
    if (op + 4 < fixed.op - 3
      && dimensions.every(n => n?.tag === 0x0a && Number.isInteger(n.value) && n.value > 0)
      && at(op + 3)?.tag === 0x0b && box?.tag === 0x25
      && Array.isArray(box.value) && box.value.length === 6 && box.value.every(Number.isFinite)) {
      header = true;
      break;
    }
  }
  if (!header || ![0x0c, 0x0d].includes(at(fixed.op - 3)?.tag) || !at(fixed.op - 1)) return null;
  const op = fixed.op - 2;
  const controllers = readAppearanceControllers(at(op), deref, symbol);
  return controllers ? { op, controllers } : null;
}
