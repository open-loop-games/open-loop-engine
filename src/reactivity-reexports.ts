/**
 * Reactivity re-exports — Vue's reactivity API, re-exported by the engine.
 *
 * Consumers should prefer these over importing from `'vue'` directly. Vue's
 * `activeEffect` is ES-module-scoped: an `effect` / `watch` / `watchEffect`
 * resolved from a separately-installed `vue` won't subscribe to refs created
 * by the engine's `vue` instance, and updates will silently miss. Importing
 * via the engine guarantees one shared reactivity graph.
 *
 * The full Vue reactivity API is not re-exported — only the symbols engine
 * consumers actually wire against. Import from `'vue'` directly when you need
 * the rest (e.g. `customRef`, `toRefs`); the activeEffect gotcha still
 * applies, so keep those uses out of code that subscribes to engine refs.
 *
 * Types are re-exported alongside the values for the same reason in the
 * type domain: `Ref` and friends are branded with unique symbols, so a
 * consumer annotating engine-facing state with types resolved from its own
 * `vue` copy fails to unify whenever that copy's declarations differ from
 * the engine's. Importing both value and type from the engine guarantees
 * one declaration source.
 *
 * @cluster reactivity
 */
export {
  effect,
  watchEffect,
  watch,
  computed,
  ref,
  shallowRef,
  triggerRef,
  reactive,
  isRef,
  unref,
  effectScope,
  onScopeDispose,
} from 'vue';
export type {
  Ref,
  ShallowRef,
  ComputedRef,
  WritableComputedRef,
  WatchStopHandle,
  EffectScope,
} from 'vue';
