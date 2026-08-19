# Sideeye diagrams

## Review decision

```mermaid
flowchart TD
    T[Read ticket and acceptance] --> E[Inspect code, tests, runtime evidence]
    E --> C[Build strongest case for proposal]
    C --> A[Attack realistic assumptions]
    A --> P{Concrete pressure exists?}
    P -->|no| S[Prefer simple direct solution]
    P -->|yes| M[Consider matching pattern]
    M --> K{Pattern reduces named risk?}
    K -->|no| S
    K -->|yes| V[Check migration, operations, rollback]
    S --> R[Verdict with ranked findings]
    V --> R
```

## Finding anatomy

```mermaid
flowchart LR
    O[Observed evidence] --> T[Trigger condition]
    T --> I[User or system impact]
    I --> F[Smallest viable fix]
    F --> Q[Verification]
```

## Explain like I'm 5

Follow the arrows like a treasure map. See what exists, find where it can fail, explain why that matters, and test the smallest repair.
