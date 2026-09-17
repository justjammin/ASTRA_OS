# OOP design: choose from pressure

Use this guide during architecture planning. These are redMage's engineering judgments and original examples, not copied catalog examples. Read the linked primary pattern page for a shortlisted candidate. If browsing is unavailable, cite this local guide as the basis and disclose that the upstream reference was not checked. Never invent live verification.

Start with a direct function or cohesive module. Add a pattern only when it buys a named requirement. A pattern does not require a class in languages with first-class functions. Respect repository conventions and abstraction thresholds. These are object-design choices; consult Grunt's separate catalogs for distributed systems, storage and resilience.

For deeper comparisons, file shapes and tested examples, read [pattern deep dives](pattern-deep-dives.md) for the shortlisted candidates.

## Selection table

| Approach | Pick when / observed pressure | Advantages | Costs / reject when | Smallest credible shape |
|---|---|---|---|---|
| Direct function/module | One cohesive operation with no demonstrated variation | Easy to trace, test and change | Split only when responsibilities actually diverge | Inputs → result; explicit dependencies |
| [Strategy](https://refactoring.guru/design-patterns/strategy) | Callers select genuinely different algorithms for one operation | Separates independently changing algorithms | Selection becomes caller responsibility; reject speculative variants | Inject a callable; class only if it owns meaningful state |
| [Adapter](https://refactoring.guru/design-patterns/adapter) | Existing external interface conflicts with the application's contract | Keeps vendor shapes at the boundary | Mapping and error translation need maintenance; reject pass-through wrapping with no mismatch | One boundary module translating inputs/results |
| [State](https://refactoring.guru/design-patterns/state) | Many operations vary with lifecycle state and transitions have rules | Makes state-specific behavior explicit | More objects and transition coordination; reject for a tiny stable enum switch | Start with an enum and transition function |
| [Factory Method](https://refactoring.guru/design-patterns/factory-method) | An established creator hierarchy needs subclasses to choose the product | Reuses workflow while varying construction | Couples design to inheritance; reject when a simple construction function works | Overridable creation method; a switch factory is not GoF Factory Method |
| [Builder](https://refactoring.guru/design-patterns/builder) | Complex construction has meaningful stages or representations | Separates assembly from finished object | Extra lifecycle and validation paths; reject for ordinary optional parameters | Plain options object first |
| [Decorator](https://refactoring.guru/design-patterns/decorator) | Behavior must compose around a stable interface | Independent wrappers can combine | Ordering and debugging become harder; reject when one explicit call suffices | Wrapper accepting and returning the same interface |
| [Facade](https://refactoring.guru/design-patterns/facade) | Callers repeatedly coordinate a complex subsystem | Smaller caller-facing surface | Can become a catch-all; reject one-caller forwarding layers | A focused use-case entry point |
| [Observer](https://refactoring.guru/design-patterns/observer) | Multiple independent listeners react to a local change | Publisher need not know each listener | Hidden ordering, lifetime and failure behavior; reject simple direct calls | Subscription with explicit unsubscribe and error policy |
| [Command](https://refactoring.guru/design-patterns/command) | Actions need identity, deferred execution or undo | Makes action data explicit | Serialization/undo add obligations; reject ordinary immediate calls | Action data plus handler; retries need separate idempotency design |
| [Composite](https://refactoring.guru/design-patterns/composite) | Leaves and nested groups share a real operation | Uniform tree traversal | Harder to constrain invalid children; reject flat collections | Recursive data union before class hierarchy |
| [Singleton](https://refactoring.guru/design-patterns/singleton) | One process-local instance is genuinely required and lifecycle is controlled | Centralizes instance ownership | Global coupling and test contamination; does not ensure distributed uniqueness | Prefer instance created at composition root and injected |

The linked [catalog](https://refactoring.guru/design-patterns/catalog) includes other candidates. Expand only for actual pressure; this is a shortlist, not a complete OOP manual.

## Distinguish similar choices

| Decision | Prefer first when | Prefer second when |
|---|---|---|
| Strategy vs State | Caller chooses how to perform an operation | Lifecycle determines allowed behavior |
| Adapter vs Facade | Contract mismatch needs translation | Subsystem coordination needs simplification |
| Decorator vs Strategy | Add behavior around the operation | Replace the operation's algorithm |
| Function vs class | Behavior is stateless or dependencies can be explicit arguments | An object owns invariants and state across calls |
| Composition vs inheritance | Behavior needs independent substitution | Existing subtype contract and substitutability are demonstrated |

## Original minimal examples (Python)

### Strategy without a class hierarchy

A shipment feature has confirmed postal and pickup pricing behavior. The orchestration receives the policy; it does not know the variants. If only postal delivery exists, call it directly instead.

```python
from collections.abc import Callable

def postal_cents(weight_grams: int) -> int:
    return 500 + 100 * ((weight_grams + 999) // 1000)

def pickup_cents(weight_grams: int) -> int:
    return 0

def quote(weight_grams: int, pricing: Callable[[int], int]) -> int:
    if weight_grams <= 0:
        raise ValueError("Weight must be positive")
    return pricing(weight_grams)

assert quote(1200, postal_cents) == 700
assert quote(1200, pickup_cents) == 0
```

File shape: keep both policies together while small; separate only when ownership or dependencies diverge. Test observable quotes, not whether a strategy object was called.

### Adapter around an incompatible response

The vendor reports cents under its own field name. The application needs a stable balance contract. Error translation and currency validation belong here when required by the real vendor contract.

```python
class BalanceAdapter:
    def __init__(self, fetch_vendor_balance):
        self.fetch_vendor_balance = fetch_vendor_balance

    def balance_cents(self, account_id: str) -> int:
        result = self.fetch_vendor_balance(account_id)
        return result["available_minor_units"]

adapter = BalanceAdapter(lambda account_id: {"available_minor_units": 2500})
assert adapter.balance_cents("account-1") == 2500
```

File shape: vendor import and mapping in the integration boundary. Avoid inventing an abstract repository around this one operation. Tests cover translations and real error semantics.

### A small lifecycle before State objects

This is a direct transition function, deliberately not a GoF State implementation. Escalate to State objects only when state-specific operations make this structure unwieldy.

```python
from enum import Enum

class Status(Enum):
    DRAFT = "draft"
    SENT = "sent"
    CANCELLED = "cancelled"

def transition(status: Status, action: str) -> Status:
    allowed = {
        (Status.DRAFT, "send"): Status.SENT,
        (Status.DRAFT, "cancel"): Status.CANCELLED,
    }
    if (status, action) not in allowed:
        raise ValueError("Transition not allowed")
    return allowed[status, action]

assert transition(Status.DRAFT, "send") == Status.SENT
try:
    transition(Status.SENT, "cancel")
except ValueError:
    pass
else:
    raise AssertionError("Sent items must not be cancelled")
```

File shape: lifecycle and transition rules live with the feature; persistence remains an explicit boundary. Test allowed and rejected user-visible transitions.

## Record the decision

For each selected or seriously considered pattern, record:

| Requirement | Pressure/evidence | Choice | Benefit | Cost | Rejected simpler alternative | Verification | Revisit trigger |
|---|---|---|---|---|---|---|---|
| FR: show external balance | Vendor response differs from domain contract | Adapter | Isolates translation | One mapping boundary | Pass vendor response through UI: leaks provider fields | Contract mapping test | Provider contract changes |

Keep the example illustrative; replace it with actual IDs, file paths, contracts and evidence. Grunt's Apply/Reject/Investigate verdict belongs beside the decision. Unknown future variants are not evidence for an abstraction.
