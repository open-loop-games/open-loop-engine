# Composition recipes: the tick

Recurring shapes that a tick handler runs, or that read what ticks wrote. Each is a worked pattern from the consumer corpus, not an engine symbol. An engine helper would over-fit each of them, because the parts consumers vary are the whole piece.

This is the companion to [consumer-guide-recipes.md](./consumer-guide-recipes.md), and it follows the same rule. A second consumer that writes the same wrapper independently is the signal to move a shape out of this file.

## Phases inside a run

A run often alternates phases: build then wave, day then night, a calm then a surge. Model them as one saved phase value and one tick handler that dispatches on it. Do not model them as TickDriver tick phases (§ When tick phases fit).

```ts
type Phase = 'setup' | 'build' | 'wave';
// Saved, so a reload resumes mid-phase. An unsaved run keeps these as plain fields.
const phase = persistent<Phase>('setup', { id: 'phase' });
const clock = persistent(0, { id: 'clock' });    // seconds into this phase
const landed = persistent(0, { id: 'landed' });  // schedule cursor for this phase

function enter(next: Phase) { phase.value = next; clock.value = 0; landed.value = 0; }

ctx.onTick((dt) => {
  if (phase.value === 'setup') return;
  clock.value += dt;
  if (phase.value === 'build') {
    if (clock.value >= buildSeconds.value) enter('wave');
    return;
  }
  // Catch-up: every arrival that is due lands, however large dt is.
  while (landed.value < arrivals.value && clock.value >= arrivalAt(landed.value)) land(landed.value++);
  if (defenceLeft() <= 0) return endRun();     // the crossing
  if (waveCleared()) enter('build');           // or: clock.value >= waveSeconds.value
});

// The player starts the wave early. The game decides what the time given up costs or pays.
function callEarly(): boolean {
  if (phase.value !== 'build') return false;
  payForTimeGivenUp();
  enter('wave');
  return true;
}
```

The phase is saved state, so a load restores it with every other ref. Nothing has to be entered again in `onLoad`, and no second record of the phase can fall out of step with the first.

The sketch encodes four rules:

- **Write the phase only through `enter`.** It zeroes the phase clock and the schedule cursor together.
- **Index the schedule by the phase clock, and catch up in a loop.** A tick's dt can exceed the gap between arrivals: offline replay, `advanceTime`, a coarse balance-harness tick. An `if` lands one arrival per tick, and the rest slip. The `while` lands every arrival that is due.
- **A phase ends on a timer or on an event.** A build ends when its seconds run out; a wave can end when it is cleared. Cutting a dwell short is a game mechanic. It can be free, pay out for the time given up, or cost a fee. The first dwell can also wait for the player.
- **The schedule's source is the game's.** It can be a closed form frozen at run start, an authored function per wave, or a `Formula`. A `Formula` also projects the crossing for a countdown: `firstPassage` returns the first input that reaches a target.

### The crossing that ends the run

A run ends at a crossing: a live comparison that changes over time. Two variants occur.

- **A hard crossing** is a buffer that bleeds to zero, such as a wall's integrity or a crew's morale. End the run on the tick it reaches zero. Write the loss as a continuous producer of that resource with a negative `baseRate`, not as a subtraction in a tick handler:
  - its tick subtracts, and stops at zero unless `allowNegative` keeps the deficit;
  - `getTotalRate` sums it into the resource's net rate;
  - `timeUntilGateFlip` predicts the crossing once your accessor's `getRate` serves that net rate. The engine does not wire it there for you.

  Gate has no less-than kind. So "below 1" is `not` over a `resource-gte` at 1.
- **A soft crossing** is a rate race, such as an upkeep rate that overtakes production. Give it a grace clock that runs while the race is lost and resets when it recovers. Compare the rates without the penalty the crossing applies. Otherwise the penalty feeds the race it is measured by.

**A crossing that ends the game,** not only the run, needs a record that no reset clears. The engine has no ended state. Keep the outcome in a lifetime ref, `persistent(false, { id: 'game-won', lifetime: true })`, or in an achievement whose goal is the crossing. Then stop play with a guard at the head of each tick handler, or with `engine.stop()`. `stop()` also stops autosave, so call `engine.save()` first. `stop()` is not saved, so after a load that finds the record set, stop again.

### The run around the phases

The run itself is a `Cycle`, or a `Reset` from `createReset`, as [api/INDEX.md § Reserved names](./api/INDEX.md#reserved-names) decides under `Cycle`. On load, resume a saved run whose phase is past its rest value. An unsaved run starts at rest on every load, so a reload forfeits it.

### When tick phases fit

TickDriver tick phases (`registerPhase`, `enterPhase`, `exitPhase`) suit a phase that is not one module's own state. One module registers the handlers, and other modules enter and exit the tick phase. Several tick phases can be entered at once. Four facts decide the fit:

- `registerPhase` keeps one handler set per name. A second registration under the same name replaces the first.
- The entered set is not saved. A game enters its tick phases again after a load, from state it did save.
- A tick phase entered during a tick first runs on the next tick.
- Each tick runs the `onTick` handlers first, then each entered tick phase's `onTick`.

A phase that one module owns, saves and dispatches on gains nothing from them. It pays the second fact: a second record of the phase, which every load must rebuild.

## Drawing ticking game state: a read-only projection

A canvas or WebGL view of a board, an arena or a scene draws game state that ticks change. The rules below hold for any drawing library.

**The cut.** Game logic resolves, and the drawing reads. The drawing reads game state each animation frame, and writes none. An instant that leaves no state behind, such as a hit, cannot be read back from state. Record it in game logic, in a list the drawing replays and clears.

**Own the loop.** Draw from an animation-frame loop: `requestAnimationFrame`, or the drawing library's own ticker. Never draw from a Vue `watch` or a component re-render. Keep the library's objects out of Vue reactivity, in plain locals or class fields. A reactive proxy costs time on every read, and drawing libraries keep their own bookkeeping on those objects. Hold the game state the drawing reads in a `shallowRef` or a plain object. Create the drawing on mount, size it to its host, and destroy it on unmount.

**Cadence.** In live play, game state changes once per interval of the TickDriver, `intervalRate` times a second, however many ticks the interval runs. So an animation frame shows a sample up to one interval old. Game speed scales dt, not the interval rate, so at a higher game speed each sample moves further. Measure smoothing on the wall clock, never in game time.

**Smoothing: choose it by what the smoothed value drives, not by the cadence.**

- *Decoration*, such as a sprite or a gauge needle: an exponential chase, `x += (goal - x) * (1 - Math.exp(-k * dt))`, with `dt` the animation frame's wall-clock seconds.
- *A value that steps a few times a second, or slower*: tween between the previous and the current sample at `alpha = (now - stepAt) / stepSeconds`. Detect a step by a version ref the game logic bumps, or by a change in a game-time counter. Flag a reset or a jump, so the tween snaps instead of sliding across it.
- *A camera, or a body the player steers*: dead reckoning. Extrapolate with the velocity of the last two samples, correct toward each new sample, cap the lead, and snap on a teleport. Pin the camera to the reckoned body, so that no value is smoothed twice. A chased camera behind a chased body judders, because the two lags differ.

**One owner for coordinates.** A container transform, a camera or a rig maps game coordinates to pixels, and nothing else does. A bounded board fits its host. A play space that scrolls, or that page chrome overlaps, needs a camera.

Why no engine helper: drawings use different libraries, and share no coordinate model, smoothing or entity lifecycle. The one tick-derived number, `alpha`, takes a consumer a few lines. A drawing library that owns its ticker would route around a shared frame-loop host.

## A player switch over a tier-gated policy

A policy that `AutomationTiers` gates often has a switch the player sets as well. The switch is one `persistent<boolean>`, read beside the gate where the policy acts. This is the player-side half of [consumer-guide-recipes.md § Shared pure state-function across live tick and harness](./consumer-guide-recipes.md#shared-pure-state-function-across-live-tick-and-harness).

```ts
const autoSellEnabled = persistent(true, { id: 'auto-sell-enabled' });

// Read both where the policy acts: a tick handler, an auto-purchase `enabled`, a binding's `active`.
const autoSelling = () => automation.hasReached('auto-sell') && autoSellEnabled.value;
ctx.onTick(() => { if (autoSelling()) sellSurplus(sellPolicy.value); });
```

- **Read the pair at the point of action.** Never copy it into the policy through a watcher. A fresh read follows a load, a reset and a probe's forced automation tier with no extra wiring.
- **Show the switch only once its gate holds.**
- **The unit is the policy, not the automation tier.** One automation tier can hold several switches, and another can run with none. Give each switch a save id named for its policy.
- **Gate on `isUnlocked` when a lower automation tier can lock alone.** `hasReached` compares `order`, so it holds for every automation tier below the highest unlocked one. After `resetUnlocks()`, a lower one can lock while a higher one stays unlocked. The same holds when a reset removes the piece one automation tier runs on. Gate such an automation tier on `isUnlocked(tierId)`, plus the game's own check that its piece exists.

Why no engine helper: the shape is one persistent ref and an `&&`. Each option a helper would need splits across consumers: the unit, the gate, the ref default and the save id.
