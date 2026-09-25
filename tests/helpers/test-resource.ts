import { createResource, type Resource } from '@/core/resource';
import type { DecimalSource } from '@/primitives/decimal';

/** A minimal resource for tests, id and display name both `name`. */
export function createTestResource(name: string, initial: DecimalSource = 0): Resource {
  return createResource(initial, { id: name, displayName: name });
}
