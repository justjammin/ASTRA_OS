# OOP design: choose from pressure

Use this guide during architecture planning. Adapted from redMage Protect's engineering guidance and original examples. Explain relevant research through self-contained examples in the generated document; do not direct the reader to external URLs.

Start with a direct function or cohesive module. Add a pattern only when it buys a named requirement. A pattern does not require a class in languages with first-class functions. Respect repository conventions and abstraction thresholds. These are object-design choices; consult Grunt's separate catalogs for distributed systems, storage and resilience.

For deeper comparisons and worked examples, read [pattern deep dives](pattern-deep-dives.md) for the shortlisted candidates.

## Selection table

| Approach | Pick when / observed pressure | Advantages | Costs / reject when | Smallest credible shape |
|---|---|---|---|---|
| Direct function/module | One cohesive operation with no demonstrated variation | Easy to trace, test and change | Split only when responsibilities actually diverge | Inputs → result; explicit dependencies |
| Strategy | Callers select genuinely different algorithms for one operation | Separates independently changing algorithms | Selection becomes caller responsibility; reject speculative variants | Inject a callable; class only if it owns meaningful state |
| Adapter | Existing external interface conflicts with the application's contract | Keeps vendor shapes at the boundary | Mapping and error translation need maintenance; reject pass-through wrapping with no mismatch | One boundary module translating inputs/results |
| State | Many operations vary with lifecycle state and transitions have rules | Makes state-specific behavior explicit | More objects and transition coordination; reject for a tiny stable enum switch | Start with an enum and transition function |
| Factory Method | An established creator hierarchy needs subclasses to choose the product | Reuses workflow while varying construction | Couples design to inheritance; reject when a simple construction function works | Overridable creation method; a switch factory is not GoF Factory Method |
| Builder | Complex construction has meaningful stages or representations | Separates assembly from finished object | Extra lifecycle and validation paths; reject for ordinary optional parameters | Plain options object first |
| Decorator | Behavior must compose around a stable interface | Independent wrappers can combine | Ordering and debugging become harder; reject when one explicit call suffices | Wrapper accepting and returning the same interface |
| Facade | Callers repeatedly coordinate a complex subsystem | Smaller caller-facing surface | Can become a catch-all; reject one-caller forwarding layers | A focused use-case entry point |
| Observer | Multiple independent listeners react to a local change | Publisher need not know each listener | Hidden ordering, lifetime and failure behavior; reject simple direct calls | Subscription with explicit unsubscribe and error policy |
| Command | Actions need identity, deferred execution or undo | Makes action data explicit | Serialization/undo add obligations; reject ordinary immediate calls | Action data plus handler; retries need separate idempotency design |
| Composite | Leaves and nested groups share a real operation | Uniform tree traversal | Harder to constrain invalid children; reject flat collections | Recursive data union before class hierarchy |
| Singleton | One process-local instance is genuinely required and lifecycle is controlled | Centralizes instance ownership | Global coupling and test contamination; does not ensure distributed uniqueness | Prefer instance created at composition root and injected |

Expand beyond this shortlist only for actual pressure; it is not a complete OOP manual.

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

The example separates pricing behavior without a class hierarchy. A single pricing policy would be simpler as a direct call.

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

The example translates an incompatible vendor response. If the response already matched what callers need, the wrapper would add no value.

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

The example makes allowed and rejected transitions explicit. A small stable lifecycle does not need a hierarchy of State objects.

## Show the decision in the document

Adapt a relevant example to the project's actual problem. Explain the observed pressure, the simplest alternative, how behavior changes, and the tradeoff. For example: a vendor balance arrives as `available_minor_units: 2500`; an Adapter exposes `balance_cents: 2500` to callers, isolating the vendor naming at the cost of one translation step. If callers can already use the vendor response unchanged, call it directly.

Keep examples illustrative, not prescribed file contracts or requirement-traceability tables. Include the explanation inline rather than an external URL. Unknown future variants are not evidence for an abstraction.
