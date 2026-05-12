import { describe, it, expect } from 'vitest'
import { bn } from '@/primitives/decimal'
import type { IResource, IEffect, ICondition, IModifier, ResourceEffect, CompositeEffect, ResourceCondition, AndCondition } from '@/primitives/types'

describe('Primitive types', () => {
  it('IResource satisfies interface', () => {
    const r: IResource = { id: 'gold', amount: bn(100) }
    expect(r.id).toBe('gold')
    expect(r.amount.eq(100)).toBe(true)
  })
  it('IResource with cap satisfies interface', () => {
    const r: IResource = { id: 'mana', amount: bn(50), cap: bn(100) }
    expect(r.cap!.eq(100)).toBe(true)
  })
  it('IEffect discriminated union works', () => {
    const effect: IEffect = { type: 'resource', target: 'gold', operation: 'add', value: 10 }
    expect(effect.type).toBe('resource')
  })
  it('Composite effect nests correctly', () => {
    const effect: CompositeEffect = {
      type: 'composite',
      effects: [
        { type: 'resource', target: 'gold', operation: 'add', value: 10 },
        { type: 'unlock', target: 'smithing', value: true },
      ],
    }
    expect(effect.effects).toHaveLength(2)
  })
  it('ICondition discriminated union works', () => {
    const cond: ResourceCondition = { type: 'resource', target: 'gold', operator: 'gte', value: 100 }
    expect(cond.type).toBe('resource')
  })
  it('Composite condition nests', () => {
    const cond: AndCondition = {
      type: 'and',
      conditions: [
        { type: 'resource', target: 'gold', operator: 'gte', value: 100 },
        { type: 'unlock', target: 'smithing' },
      ],
    }
    expect(cond.conditions).toHaveLength(2)
  })
  it('IModifier interface compiles', () => {
    const mod: IModifier = { apply: (v) => v.add(10), enabled: true, description: '+10' }
    expect(mod.apply(bn(5)).eq(15)).toBe(true)
  })
})
