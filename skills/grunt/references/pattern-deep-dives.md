# Pattern deep dives

Read only the candidates relevant to the current requirements. These original engineering notes extend the local shortlist; they are not copied tutorials. Linked Refactoring.Guru pages were consulted on 2026-09-10. The pressure, file-shape, test and rejection recommendations below are redMage's application guidance, not guarantees from the source.

## 1. Construction: Builder or Abstract Factory?

| Choice | Pick when | Benefit | Cost / reject when | File shape and evidence |
|---|---|---|---|---|
| Options object | Construction is a single understandable operation | Few moving parts | Poor fit if intermediate steps have substantive rules | Constructor/function beside the resulting type |
| [Builder](https://refactoring.guru/design-patterns/builder) | A real multi-step assembly process produces complex representations | Keeps assembly separate from the final object | Adds intermediate state; ordinary optional parameters do not justify it | Builder owns incomplete state; result owns finished invariants; show actual assembly sequences |
| [Abstract Factory](https://refactoring.guru/design-patterns/abstract-factory) | A selected family must produce several compatible product types | Prevents callers from mixing incompatible family implementations | New product categories change every family; reject a factory for one product | Factory interface beside the product contracts; family implementations at the integration boundary |

Builder varies assembly; Abstract Factory varies a compatible family. Neither is the same as a function selecting one concrete object. A fluent API alone is not proof that Builder is warranted.

Before choosing Builder, demonstrate which invalid intermediate combinations it prevents and when validation occurs. Test the finished result and failed assembly, not chaining syntax. Before choosing Abstract Factory, demonstrate a mixed-family failure; test compatibility across products and each real family. Do not introduce either for anticipated future providers.

## 2. Composition: Decorator or Bridge?

| Choice | Pick when | Benefit | Cost / reject when | File shape and evidence |
|---|---|---|---|---|
| [Decorator](https://refactoring.guru/design-patterns/decorator) | Optional behaviors wrap the same contract in meaningful combinations | Composition without a subclass for every combination | Wrapper ordering affects semantics; reject for one fixed extra call | Thin wrappers beside the contract; wiring chooses order explicitly |
| [Bridge](https://refactoring.guru/design-patterns/bridge) | Two demonstrated dimensions vary independently | Avoids a cross-product of subclasses | Two hierarchies add indirection; reject when only one dimension varies | High-level operation holds an implementation contract; each dimension owns separate behavior |

A notification operation with different transports may need a simple injected function. Bridge becomes plausible when both notification forms and transports have substantial, independently evolving behavior. Adapter instead reconciles a contract mismatch that already exists.

For Decorator, write down order and exception behavior before introducing wrappers. Test combined behavior, not just each wrapper in isolation. For Bridge, test the required combinations and explain ownership of orchestration versus primitive operations. Do not build unsupported combinations merely because the structure permits them.

## 3. Actions: Command or Observer?

| Choice | Pick when | Benefit | Cost / reject when | File shape and evidence |
|---|---|---|---|---|
| Direct call | One known caller needs one immediate result | Explicit control and errors | Awkward only when action lifecycle is a requirement | Ordinary function with explicit dependencies |
| [Command](https://refactoring.guru/design-patterns/command) | An action needs its own identity, delay or undo lifecycle | Separates action description from execution | Stale captured state and undo obligations; reject classes around immediate calls | Command data and handler within the feature; storage only if durability is required |
| [Observer](https://refactoring.guru/design-patterns/observer) | Several independent consumers subscribe to a local state change | Publisher avoids hardcoded listener knowledge | Hidden ordering, lifetime and exceptions; reject a mandatory linear workflow | Event contract near publisher; explicit subscription wiring and unsubscription |

Command expresses an instruction; an event reports something that happened. Observer does not supply durable delivery, transactions or exactly-once effects. A queued command needs a separate design for persistence, duplicate execution, authorization and version compatibility. Undo is not synonymous with reversing arbitrary external effects.

For Command, test execution plus the actual lifecycle capability motivating it. For Observer, test subscription lifetime, delivery policy, reentrancy and listener failure handling only where those are real concerns. Required ordered steps usually belong in explicit orchestration.

## 4. Original runnable example: decorator ordering

An export operation supports selectable labels and casing. The same contract wraps an inner operation. This illustrates composition; it does not establish that a real project needs these wrappers.

```python
from collections.abc import Callable

Render = Callable[[str], str]

def label(inner: Render) -> Render:
    return lambda text: "Export: " + inner(text)

def uppercase(inner: Render) -> Render:
    return lambda text: inner(text).upper()

def plain(text: str) -> str:
    return text

assert label(uppercase(plain))("draft") == "Export: DRAFT"
assert uppercase(label(plain))("draft") == "EXPORT: DRAFT"
```

The order changes observable output. A project using decorators should specify the intended order in wiring and verify it at the public seam. If only one combination exists, a single formatting function is simpler.

## 5. Original runnable example: a bounded command with undo

A local editor can undo its most recent append. This example intentionally limits undo to the state it produced; it does not claim persistence or concurrent-edit support.

```python
class Append:
    def __init__(self, document: list[str], text: str):
        self.document = document
        self.text = text
        self.before = None

    def execute(self):
        if self.before is not None:
            raise ValueError("Command already executed")
        self.before = self.document.copy()
        self.document.append(self.text)

    def undo(self):
        if self.before is None:
            raise ValueError("Command has not executed")
        if self.document != self.before + [self.text]:
            raise ValueError("Document changed; undo requires reconciliation")
        self.document[:] = self.before
        self.before = None

lines = ["first"]
command = Append(lines, "second")
command.execute()
assert lines == ["first", "second"]
command.undo()
assert lines == ["first"]
command.execute()
lines.append("third")
try:
    command.undo()
except ValueError:
    pass
else:
    raise AssertionError("Undo must reject intervening edits")
```

Full snapshots are suitable only for this tiny illustration. Real editors must choose a history/concurrency model from their requirements. If undo is not required, append directly.

## 6. Hydrate the selected pattern into the project

For each serious candidate, Grunt checks that the author records:

1. Requirement ID and observed pressure, with code/measurement evidence.
2. Source page and consulted date; separate source intent from local inference.
3. Simplest alternative and why it is insufficient (or why the pattern is rejected).
4. Actual participant names and dependency direction at Gate 2; exact files and signatures at Gate 3.
5. Ownership of state, errors, lifetime, transitions and side effects.
6. Concrete positive/failure acceptance cases at the agreed seam.
7. Cost, Apply/Reject/Investigate verdict and a measurable revisit trigger.

Astra Gate 3 carries those decisions into file contracts and verification steps. Gate 4 plans their slices. Gate 5 implements only the accepted pattern's needed participants and checks that the abstraction still earns its place. A source citation supports a pattern's definition, not the claim that the project needs it.
