## ADDED Requirements

### Requirement: Each chat turn has one stable identity

Each rendered turn MUST be identified by an identity that is stable across
rebuilds, unique within the lifetime of the chat history, independent of the
list index, and unchanged when the history is restored from storage — so that a
list that shifts (trim, prepend, replacement) can never make one turn render
another turn's state.

#### Scenario: identity survives a rebuild and a restore

- **WHEN** the same history is rendered twice, and after being serialized and
  restored
- **THEN** every turn's identity is the same value both times and no two turns
  share an identity

### Requirement: Card outcome state is classified, not assumed

Every piece of state held by a proposal card MUST be classified as either
ephemeral UI state (safe to reset when the card is recreated) or business
outcome (must stay attached to its own turn). A keyed list fixes attribution — a
card MUST NOT display another turn's outcome — but a business outcome that must
survive recreation MUST come from the turn model, not from card-local state; if
it does not, that limitation MUST be recorded rather than assumed away.

#### Scenario: an outcome never moves between turns

- **WHEN** the history shifts and a turn is trimmed from the front
- **THEN** each remaining card shows its own outcome (or no outcome), and no
  card shows the outcome of the trimmed or of another turn

### Requirement: The chat list keeps each turn's outcome on its own bubble

The chat history list MUST key each rendered turn by that turn's own identity
(not by its position), so that a change in the list content — in particular
`trimTurns` dropping the oldest turn once the history passes `maxChatItems` —
can never move one turn's locally-held UI state (a confirmed card's outcome
line, an error, a locally-stamped refusal) onto a different turn's bubble.

#### Scenario: a confirmed card's outcome never appears on another turn

- **WHEN** a card is confirmed and the history then shifts (a turn is dropped
  from the front because the cap was reached, and a new turn is appended)
- **THEN** the outcome line is not rendered inside any other turn's card, and the
  other cards render their own state only
