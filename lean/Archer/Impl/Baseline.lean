import Archer.Spec.Baseline

/-!
# Fingerprint encoding and baselines

Implements `Spec.EncodeSpec` (F1, F2) and `Spec.BaselineSpec` (B1 to B5).
Contract: `docs/verification.md`.

## Format

A baseline file holds one encoded fingerprint per line. The TypeScript port
must reproduce `encode` byte for byte and `decode` as a strict parser.

```
line   ::= field ('|' field)*          fields: rule id, subject, key
```

Field text is escaped. Two nesting levels exist, each with its own separator:

| Level  | Separator | Escape for the separator | Used for |
| ------ | --------- | ------------------------ | -------- |
| field  | `\|`      | `\p`                     | a line is split into fields |
| path   | `/`       | `\s`                     | a path field is split into segments |

At either level the escape character is `\`, and four more escapes apply:

| Character | Escape |
| --------- | ------ |
| `\`       | `\\`   |
| newline   | `\n`   |
| carriage return | `\r` |
| the level's separator | its code (`\p` or `\s`) |

Every other character stands for itself, so a plain rule ID stays readable.
A decoder rejects any other backslash sequence and a trailing backslash.

A path, a list of segments, encodes as `/` before each segment, with the
segment escaped at path level: `["src", "a.ts"]` is `/src/a.ts` and `[]` is
the empty field. The whole path text is then escaped again as a field, which
changes only text that holds a backslash or a `|`.

A line holds three groups of fields: the rule ID, the subject path, and the
key. The key starts with a tag word. The words below are all distinct, so a
tag identifies its constructor in every position.

| Key | Fields after the subject |
| --- | --- |
| `FingerprintKey.target t` | `target`, then the target |
| `missing`, `cycle`, `name`, `lines` | the tag alone |
| `dependency t spec kind` | `dependency`, kind, specifier, then the target |
| `declaration n`, `export n`, `custom m` | the tag, then the text |
| `use kind name binding` | `use`, kind, name, then the binding |

A target is `file` and a path, `package`, a name and a subpath, `builtin`,
`node` or `bun` and a name, `unresolved` and a specifier, or `computed`.
A binding is `global`, `local`, or `imported`, a source and a name. A
dependency kind is `static`, `type`, `require`, or `dynamic`, and a use kind
is `call` or `looseEquality`.

A decoder splits the line at every `|`, which is safe because an escaped
field never holds one. It unescapes each piece at field level, splits a path
field at every `/` the same way, requires the first piece to be empty, and
unescapes the rest at path level. It reads the tag, then the fields that the
tag requires, and rejects a line with fewer or more.

Examples:

```
no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts
max-lines|/src/big.ts|lines
r||missing
a\pb|/x\\sy/\\\\|custom|one\ntwo
```

The last line is the rule ID `a|b`, the subject `["x/y", "\\"]`, and the
message `one`, a newline, `two`. A backslash in a segment is doubled at path
level and doubled again at field level, and the `/` in `x/y` is `\s` at path
level and `\\s` at field level.
-/

namespace Archer.Impl.Baseline

open Archer

/-! ## Escaping and splitting -/

/-- A nesting level: a separator and the letter that escapes it. The side
conditions keep the escapes of one level apart from each other and from the
separator, and keep newlines out of the output. -/
structure Level where
  sep : Char
  code : Char
  ok : sep ≠ '\\' ∧ sep ≠ code ∧ sep ≠ 'n' ∧ sep ≠ 'r' ∧ sep ≠ '\n' ∧ sep ≠ '\r' ∧
    code ≠ '\\' ∧ code ≠ 'n' ∧ code ≠ 'r' ∧ code ≠ '\n' := by decide

/-- Fields of a line, split at `|`. -/
def fieldLevel : Level := ⟨'|', 'p', by decide⟩

/-- Segments of a path field, split at `/`. -/
def pathLevel : Level := ⟨'/', 's', by decide⟩

namespace Level

/-- Escape one character. -/
def escChar (L : Level) (c : Char) : List Char :=
  if c = '\\' then ['\\', '\\']
  else if c = L.sep then ['\\', L.code]
  else if c = '\n' then ['\\', 'n']
  else if c = '\r' then ['\\', 'r']
  else [c]

/-- The character that the escape `\d` stands for. -/
def unescChar (L : Level) (d : Char) : Option Char :=
  if d = '\\' then some '\\'
  else if d = L.code then some L.sep
  else if d = 'n' then some '\n'
  else if d = 'r' then some '\r'
  else none

/-- Escape a text. The result holds no separator and no newline. -/
def esc (L : Level) (w : List Char) : List Char :=
  w.flatMap L.escChar

/-- The decoder as an automaton. The flag says that the previous character
was a backslash. -/
def unescFrom (L : Level) : Bool → List Char → Option (List Char)
  | false, [] => some []
  | true, [] => none
  | false, c :: cs =>
    if c = '\\' then L.unescFrom true cs else (L.unescFrom false cs).map (c :: ·)
  | true, c :: cs => (L.unescChar c).bind fun e => (L.unescFrom false cs).map (e :: ·)

/-- Undo `esc`, or fail on a backslash sequence that `esc` never writes. -/
def unesc (L : Level) (w : List Char) : Option (List Char) :=
  L.unescFrom false w

/-- Undo `esc` on every text of a list. -/
def unescAll (L : Level) : List (List Char) → Option (List (List Char))
  | [] => some []
  | e :: es => (L.unesc e).bind fun w => (L.unescAll es).map (w :: ·)

end Level

/-- Split at every `sep`: the text before the first one, and the texts after
each one. -/
def split (sep : Char) : List Char → List Char × List (List Char)
  | [] => ([], [])
  | c :: cs =>
    match split sep cs with
    | (w, ws) => if c = sep then ([], w :: ws) else (c :: w, ws)

/-- Each text preceded by `sep`. -/
def joinSeq (sep : Char) (es : List (List Char)) : List Char :=
  es.flatMap fun e => sep :: e

/-- Text without the separator is a single piece. -/
theorem split_of_notMem {sep : Char} :
    ∀ {w : List Char}, sep ∉ w → split sep w = (w, [])
  | [], _ => rfl
  | c :: cs, h => by
      have hc : c ≠ sep := fun e => h (e ▸ List.mem_cons_self ..)
      have ih := split_of_notMem (sep := sep) (w := cs)
        (fun m => h (List.mem_cons_of_mem _ m))
      simp [split, ih, hc]

/-- A separator ends the piece before it and starts the split of the rest. -/
theorem split_append_sep {sep : Char} (t : List Char) :
    ∀ {w : List Char}, sep ∉ w →
      split sep (w ++ sep :: t) = (w, (split sep t).1 :: (split sep t).2)
  | [], _ => by simp [split]
  | c :: cs, h => by
      have hc : c ≠ sep := fun e => h (e ▸ List.mem_cons_self ..)
      have ih := split_append_sep t (w := cs)
        (fun m => h (List.mem_cons_of_mem _ m))
      simp [split, ih, hc]

/-- Splitting undoes `joinSeq` when no piece holds the separator. -/
theorem split_joinSeq {sep : Char} :
    ∀ {es : List (List Char)} {w : List Char}, sep ∉ w → (∀ e ∈ es, sep ∉ e) →
      split sep (w ++ joinSeq sep es) = (w, es)
  | [], w, hw, _ => by simp [joinSeq, split_of_notMem hw]
  | e :: es, w, hw, he => by
      have ih := split_joinSeq (sep := sep) (es := es) (w := e)
        (he e (List.mem_cons_self ..))
        (fun e' m => he e' (List.mem_cons_of_mem _ m))
      simp only [joinSeq, List.flatMap_cons] at ih ⊢
      rw [List.cons_append, split_append_sep _ hw, ih]

namespace Level

theorem escChar_backslash (L : Level) : L.escChar '\\' = ['\\', '\\'] := by
  simp [escChar]

theorem escChar_sep (L : Level) : L.escChar L.sep = ['\\', L.code] := by
  obtain ⟨h1, -⟩ := L.ok
  simp [escChar, h1]

theorem escChar_newline (L : Level) : L.escChar '\n' = ['\\', 'n'] := by
  obtain ⟨-, -, -, -, h5, -⟩ := L.ok
  simp [escChar, Ne.symm h5]

theorem escChar_return (L : Level) : L.escChar '\r' = ['\\', 'r'] := by
  obtain ⟨-, -, -, -, -, h6, -⟩ := L.ok
  simp [escChar, Ne.symm h6]

theorem escChar_plain (L : Level) {c : Char} (h1 : c ≠ '\\') (h2 : c ≠ L.sep)
    (h3 : c ≠ '\n') (h4 : c ≠ '\r') : L.escChar c = [c] := by
  simp [escChar, h1, h2, h3, h4]

theorem sep_notMem_escChar (L : Level) (c : Char) : L.sep ∉ L.escChar c := by
  obtain ⟨h1, h2, h3, h4, -, -, -⟩ := L.ok
  by_cases a : c = '\\'
  · subst a; simp [escChar_backslash, h1]
  by_cases b : c = L.sep
  · subst b; simp [escChar_sep, h1, h2]
  by_cases d : c = '\n'
  · subst d; simp [escChar_newline, h1, h3]
  by_cases e : c = '\r'
  · subst e; simp [escChar_return, h1, h4]
  · simp [escChar_plain L a b d e, Ne.symm b]

theorem newline_notMem_escChar (L : Level) (c : Char) : '\n' ∉ L.escChar c := by
  obtain ⟨-, -, -, -, -, -, -, -, -, h9⟩ := L.ok
  by_cases a : c = '\\'
  · subst a; simp [escChar_backslash]
  by_cases b : c = L.sep
  · subst b; simp [escChar_sep, Ne.symm h9]
  by_cases d : c = '\n'
  · subst d; simp [escChar_newline]
  by_cases e : c = '\r'
  · subst e; simp [escChar_return]
  · simp [escChar_plain L a b d e, Ne.symm d]

/-- Escaped text never holds the separator. -/
theorem sep_notMem_esc (L : Level) (w : List Char) : L.sep ∉ L.esc w := by
  induction w with
  | nil => simp [esc]
  | cons c cs ih =>
      simp only [esc, List.flatMap_cons, List.mem_append, not_or] at ih ⊢
      exact ⟨L.sep_notMem_escChar c, ih⟩

/-- Escaped text never holds a newline. -/
theorem newline_notMem_esc (L : Level) (w : List Char) : '\n' ∉ L.esc w := by
  induction w with
  | nil => simp [esc]
  | cons c cs ih =>
      simp only [esc, List.flatMap_cons, List.mem_append, not_or] at ih ⊢
      exact ⟨L.newline_notMem_escChar c, ih⟩

theorem unesc_plain (L : Level) {c : Char} (h : c ≠ '\\') (cs : List Char) :
    L.unesc (c :: cs) = (L.unesc cs).map (c :: ·) := by
  simp [unesc, unescFrom, h]

/-- The decoder reads back a single escaped character. -/
theorem unesc_escChar (L : Level) (c : Char) (rest : List Char) :
    L.unesc (L.escChar c ++ rest) = (L.unesc rest).map (c :: ·) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10⟩ := L.ok
  by_cases a : c = '\\'
  · subst a; simp [escChar_backslash, unesc, unescFrom, unescChar]
  by_cases b : c = L.sep
  · subst b; simp [escChar_sep, unesc, unescFrom, unescChar, h7]
  by_cases d : c = '\n'
  · subst d; simp [escChar_newline, unesc, unescFrom, unescChar, Ne.symm h8]
  by_cases e : c = '\r'
  · subst e; simp [escChar_return, unesc, unescFrom, unescChar, Ne.symm h9]
  · rw [escChar_plain L a b d e, List.singleton_append, unesc_plain L a]

/-- F1 for one level: unescaping inverts escaping. -/
theorem unesc_esc (L : Level) (w : List Char) : L.unesc (L.esc w) = some w := by
  induction w with
  | nil => rfl
  | cons c cs ih =>
      simp only [esc, List.flatMap_cons] at ih ⊢
      rw [unesc_escChar, ih]
      rfl

/-- `unescAll` inverts `esc` on a list of texts. -/
theorem unescAll_map_esc (L : Level) (ws : List (List Char)) :
    L.unescAll (ws.map L.esc) = some ws := by
  induction ws with
  | nil => rfl
  | cons w ws ih => simp [unescAll, unesc_esc, ih]

end Level

/-! ## Sequences and fields -/

namespace Level

/-- A list of texts, each escaped and preceded by the separator. -/
def encSeq (L : Level) (ws : List (List Char)) : List Char :=
  joinSeq L.sep (ws.map L.esc)

/-- Undo `encSeq`. The text must start with the separator, or be empty. -/
def decSeq (L : Level) (text : List Char) : Option (List (List Char)) :=
  match split L.sep text with
  | ([], es) => L.unescAll es
  | _ => none

/-- A nonempty list of texts: the first escaped, the others as in `encSeq`. -/
def encFields (L : Level) : List (List Char) → List Char
  | [] => []
  | w :: ws => L.esc w ++ L.encSeq ws

/-- Undo `encFields` on a nonempty list. -/
def decFields (L : Level) (text : List Char) : Option (List (List Char)) :=
  match split L.sep text with
  | (h, es) => (L.unesc h).bind fun w => (L.unescAll es).map (w :: ·)

theorem sep_notMem_of_mem_map_esc (L : Level) {ws : List (List Char)} :
    ∀ e ∈ ws.map L.esc, L.sep ∉ e := by
  intro e he
  obtain ⟨w, -, rfl⟩ := List.mem_map.mp he
  exact L.sep_notMem_esc w

theorem split_encSeq (L : Level) {w : List Char} (hw : L.sep ∉ w) (ws : List (List Char)) :
    split L.sep (w ++ L.encSeq ws) = (w, ws.map L.esc) :=
  split_joinSeq hw (L.sep_notMem_of_mem_map_esc)

/-- `decSeq` inverts `encSeq`. -/
theorem decSeq_encSeq (L : Level) (ws : List (List Char)) :
    L.decSeq (L.encSeq ws) = some ws := by
  have h := L.split_encSeq (w := []) (by simp) ws
  rw [List.nil_append] at h
  simp [decSeq, h, unescAll_map_esc]

/-- `decFields` inverts `encFields`. -/
theorem decFields_encFields (L : Level) (w : List Char) (ws : List (List Char)) :
    L.decFields (L.encFields (w :: ws)) = some (w :: ws) := by
  have h := L.split_encSeq (L.sep_notMem_esc w) ws
  simp [decFields, encFields, h, unesc_esc, unescAll_map_esc]

theorem newline_notMem_encSeq (L : Level) (ws : List (List Char)) :
    '\n' ∉ L.encSeq ws := by
  have h5 : L.sep ≠ '\n' := L.ok.2.2.2.2.1
  induction ws with
  | nil => simp [encSeq, joinSeq]
  | cons w ws ih =>
      simp only [encSeq, joinSeq, List.map_cons, List.flatMap_cons, List.cons_append,
        List.mem_cons, List.mem_append, not_or] at ih ⊢
      exact ⟨fun h => h5 h.symm, L.newline_notMem_esc w, ih⟩

theorem newline_notMem_encFields (L : Level) (fs : List (List Char)) :
    '\n' ∉ L.encFields fs := by
  cases fs with
  | nil => simp [encFields]
  | cons w ws =>
      simp only [encFields, List.mem_append, not_or]
      exact ⟨L.newline_notMem_esc w, L.newline_notMem_encSeq ws⟩

end Level

/-! ## Tags -/

/-- The words that tag a constructor. All 26 are distinct, so a tag names
its constructor in every position of a line. -/
inductive Tag where
  | file | package | builtin | unresolved | computed
  | node | bun
  | static | type | require | dynamic
  | call | looseEquality
  | «global» | «local» | imported
  | target | missing | cycle | dependency | declaration | «export» | use | name
  | lines | custom
  deriving DecidableEq

/-- The word written for a tag. -/
def Tag.text : Tag → List Char
  | .file => "file".toList
  | .package => "package".toList
  | .builtin => "builtin".toList
  | .unresolved => "unresolved".toList
  | .computed => "computed".toList
  | .node => "node".toList
  | .bun => "bun".toList
  | .static => "static".toList
  | .type => "type".toList
  | .require => "require".toList
  | .dynamic => "dynamic".toList
  | .call => "call".toList
  | .looseEquality => "looseEquality".toList
  | .global => "global".toList
  | .local => "local".toList
  | .imported => "imported".toList
  | .target => "target".toList
  | .missing => "missing".toList
  | .cycle => "cycle".toList
  | .dependency => "dependency".toList
  | .declaration => "declaration".toList
  | .export => "export".toList
  | .use => "use".toList
  | .name => "name".toList
  | .lines => "lines".toList
  | .custom => "custom".toList

/-- Every tag. -/
def Tag.all : List Tag :=
  [.file, .package, .builtin, .unresolved, .computed, .node, .bun, .static, .type,
    .require, .dynamic, .call, .looseEquality, .global, .local, .imported, .target,
    .missing, .cycle, .dependency, .declaration, .export, .use, .name, .lines, .custom]

/-- The tag that a word spells, if any. -/
def Tag.ofText (w : List Char) : Option Tag :=
  Tag.all.find? fun t => decide (t.text = w)

/-- A tag's word spells that tag and no other. -/
theorem Tag.ofText_text (t : Tag) : Tag.ofText t.text = some t := by
  cases t <;> decide

/-- The tags of the enumeration types, with the maps that read them back. -/
def runtimeTag : Runtime → Tag
  | .node => .node
  | .bun => .bun

def Tag.toRuntime : Tag → Option Runtime
  | .node => some .node
  | .bun => some .bun
  | _ => none

def dependencyKindTag : DependencyKind → Tag
  | .static => .static
  | .type => .type
  | .require => .require
  | .dynamic => .dynamic

def Tag.toDependencyKind : Tag → Option DependencyKind
  | .static => some .static
  | .type => some .type
  | .require => some .require
  | .dynamic => some .dynamic
  | _ => none

def useKindTag : UseKind → Tag
  | .call => .call
  | .looseEquality => .looseEquality

def Tag.toUseKind : Tag → Option UseKind
  | .call => some .call
  | .looseEquality => some .looseEquality
  | _ => none

/-- Read a word as an enumeration constructor. -/
def parseEnum {α : Type} (f : Tag → Option α) (w : List Char) : Option α :=
  (Tag.ofText w).bind f

theorem parseEnum_runtime (r : Runtime) :
    parseEnum Tag.toRuntime (runtimeTag r).text = some r := by
  cases r <;> simp [parseEnum, Tag.ofText_text, runtimeTag, Tag.toRuntime]

theorem parseEnum_dependencyKind (k : DependencyKind) :
    parseEnum Tag.toDependencyKind (dependencyKindTag k).text = some k := by
  cases k <;> simp [parseEnum, Tag.ofText_text, dependencyKindTag, Tag.toDependencyKind]

theorem parseEnum_useKind (k : UseKind) :
    parseEnum Tag.toUseKind (useKindTag k).text = some k := by
  cases k <;> simp [parseEnum, Tag.ofText_text, useKindTag, Tag.toUseKind]

/-! ## Fingerprints as fields -/

/-- A path as one field: `/` before each escaped segment. -/
def pathText (p : FilePath) : List Char :=
  pathLevel.encSeq (p.map String.toList)

/-- Read a path field. -/
def parsePath (w : List Char) : Option FilePath :=
  (pathLevel.decSeq w).map (·.map String.ofList)

/-- A path field reads back to its path. -/
theorem parsePath_pathText (p : FilePath) : parsePath (pathText p) = some p := by
  simp [parsePath, pathText, pathLevel.decSeq_encSeq, List.map_map, Function.comp_def]

/-- The fields of a target: its tag, then its parts. -/
def targetFields : Target → List (List Char)
  | .file p => [Tag.file.text, pathText p]
  | .package n s => [Tag.package.text, n.toList, pathText s]
  | .builtin r n => [Tag.builtin.text, (runtimeTag r).text, n.toList]
  | .unresolved s => [Tag.unresolved.text, s.toList]
  | .computed => [Tag.computed.text]

/-- Read exactly the fields of one target. -/
def parseTarget : List (List Char) → Option Target
  | [] => none
  | tag :: args =>
    match Tag.ofText tag, args with
    | some .file, [p] => (parsePath p).map Target.file
    | some .package, [n, s] => (parsePath s).map (Target.package (String.ofList n))
    | some .builtin, [r, n] =>
        (parseEnum Tag.toRuntime r).map fun r => Target.builtin r (String.ofList n)
    | some .unresolved, [s] => some (Target.unresolved (String.ofList s))
    | some .computed, [] => some Target.computed
    | _, _ => none

/-- A target's fields read back to the target. -/
theorem parseTarget_targetFields (t : Target) : parseTarget (targetFields t) = some t := by
  cases t <;>
    simp [targetFields, parseTarget, Tag.ofText_text, parsePath_pathText,
      parseEnum_runtime]

/-- The fields of a binding: its tag, then its parts. -/
def bindingFields : Binding → List (List Char)
  | .global => [Tag.global.text]
  | .local => [Tag.local.text]
  | .imported i => [Tag.imported.text, i.source.toList, i.name.toList]

/-- Read exactly the fields of one binding. -/
def parseBinding : List (List Char) → Option Binding
  | [] => none
  | tag :: args =>
    match Tag.ofText tag, args with
    | some .global, [] => some Binding.global
    | some .local, [] => some Binding.local
    | some .imported, [s, n] =>
        some (Binding.imported ⟨String.ofList s, String.ofList n⟩)
    | _, _ => none

/-- A binding's fields read back to the binding. -/
theorem parseBinding_bindingFields (b : Binding) :
    parseBinding (bindingFields b) = some b := by
  cases b <;> simp [bindingFields, parseBinding, Tag.ofText_text]

/-- The fields of a key: its tag, then its parts. Parts of fixed width come
first, so the target or binding that ends a key takes all remaining fields. -/
def keyFields : FingerprintKey → List (List Char)
  | .target t => Tag.target.text :: targetFields t
  | .missing => [Tag.missing.text]
  | .cycle => [Tag.cycle.text]
  | .dependency t s k =>
      Tag.dependency.text :: (dependencyKindTag k).text :: s.toList :: targetFields t
  | .declaration n => [Tag.declaration.text, n.toList]
  | .export n => [Tag.export.text, n.toList]
  | .use k n b => Tag.use.text :: (useKindTag k).text :: n.toList :: bindingFields b
  | .name => [Tag.name.text]
  | .lines => [Tag.lines.text]
  | .custom m => [Tag.custom.text, m.toList]

/-- Read exactly the fields of one key. -/
def parseKey : List (List Char) → Option FingerprintKey
  | [] => none
  | tag :: args =>
    match Tag.ofText tag, args with
    | some .target, t => (parseTarget t).map FingerprintKey.target
    | some .missing, [] => some FingerprintKey.missing
    | some .cycle, [] => some FingerprintKey.cycle
    | some .dependency, k :: s :: t =>
        match parseEnum Tag.toDependencyKind k, parseTarget t with
        | some k, some t => some (FingerprintKey.dependency t (String.ofList s) k)
        | _, _ => none
    | some .declaration, [n] => some (FingerprintKey.declaration (String.ofList n))
    | some .export, [n] => some (FingerprintKey.export (String.ofList n))
    | some .use, k :: n :: b =>
        match parseEnum Tag.toUseKind k, parseBinding b with
        | some k, some b => some (FingerprintKey.use k (String.ofList n) b)
        | _, _ => none
    | some .name, [] => some FingerprintKey.name
    | some .lines, [] => some FingerprintKey.lines
    | some .custom, [m] => some (FingerprintKey.custom (String.ofList m))
    | _, _ => none

/-- A key's fields read back to the key. -/
theorem parseKey_keyFields (k : FingerprintKey) : parseKey (keyFields k) = some k := by
  cases k <;>
    simp [keyFields, parseKey, Tag.ofText_text, parseTarget_targetFields,
      parseBinding_bindingFields, parseEnum_dependencyKind, parseEnum_useKind]

/-- The fields of a line: rule ID, subject, then the key. -/
def fingerprintFields (x : Fingerprint) : List (List Char) :=
  x.ruleId.toList :: pathText x.subject :: keyFields x.key

/-- Read the fields of a line. -/
def parseFingerprint : List (List Char) → Option Fingerprint
  | r :: s :: k =>
    match parsePath s, parseKey k with
    | some subject, some key => some ⟨String.ofList r, subject, key⟩
    | _, _ => none
  | _ => none

/-- A fingerprint's fields read back to the fingerprint. -/
theorem parseFingerprint_fingerprintFields (x : Fingerprint) :
    parseFingerprint (fingerprintFields x) = some x := by
  obtain ⟨r, s, k⟩ := x
  simp [fingerprintFields, parseFingerprint, parsePath_pathText, parseKey_keyFields]

/-- The characters of an encoded fingerprint. -/
def encodeChars (x : Fingerprint) : List Char :=
  fieldLevel.encFields (fingerprintFields x)

/-- Read an encoded line, or fail. -/
def decodeChars (w : List Char) : Option Fingerprint :=
  (fieldLevel.decFields w).bind parseFingerprint

/-- F1 over characters. -/
theorem decodeChars_encodeChars (x : Fingerprint) :
    decodeChars (encodeChars x) = some x := by
  simp only [decodeChars, encodeChars, fingerprintFields]
  rw [fieldLevel.decFields_encFields]
  exact parseFingerprint_fingerprintFields x

/-- F2 over characters. -/
theorem newline_notMem_encodeChars (x : Fingerprint) : '\n' ∉ encodeChars x :=
  fieldLevel.newline_notMem_encFields _

/-! ## Baselines -/

/-- The elements of a list once each, in order of first occurrence. -/
def dedup {α : Type} [DecidableEq α] : List α → List α
  | [] => []
  | x :: xs => x :: (dedup xs).filter fun y => decide (y ≠ x)

/-- `dedup` keeps exactly the elements of the list. -/
theorem mem_dedup {α : Type} [DecidableEq α] {y : α} :
    ∀ {xs : List α}, y ∈ dedup xs ↔ y ∈ xs
  | [] => by simp [dedup]
  | x :: xs => by
      by_cases h : y = x
      · simp [dedup, h]
      · simp [dedup, h, List.mem_filter, mem_dedup (xs := xs)]

/-- `dedup` lists each element once. -/
theorem nodup_dedup {α : Type} [DecidableEq α] :
    ∀ xs : List α, (dedup xs).Nodup
  | [] => List.nodup_nil
  | x :: xs => by
      refine List.nodup_cons.mpr ⟨?_, List.Pairwise.filter _ (nodup_dedup xs)⟩
      simp [List.mem_filter]

end Archer.Impl.Baseline

namespace Archer.Impl

open Archer Archer.Spec Baseline

/-- The line that a baseline file stores for a fingerprint. -/
def encode : EncodeFn := fun x => String.ofList (encodeChars x)

/-- Read a line of a baseline file, or `none` when it is not an encoding. -/
def decode : DecodeFn := fun s => decodeChars s.toList

/-- F1 and F2: decoding recovers every fingerprint, and a line has no newline. -/
theorem encode_spec : EncodeSpec encode decode where
  roundTrip x := by
    simp [encode, decode, decodeChars_encodeChars]
  singleLine x := by
    simp [encode, newline_notMem_encodeChars]

/-- Split violations by a baseline. The stale entries are those that no
violation has, once each. -/
def apply : ApplyFn := fun b vs =>
  { kept := vs.filter fun v => decide (v.fingerprint ∉ b)
    suppressed := vs.filter fun v => decide (v.fingerprint ∈ b)
    stale := (dedup b).filter fun x => decide (∀ v ∈ vs, v.fingerprint ≠ x) }

/-- The baseline that suppresses exactly the given violations: their
fingerprints, once each, in order of first occurrence. -/
def record : RecordFn := fun vs => dedup (vs.map Violation.fingerprint)

/-- B1 to B5. -/
theorem baseline_spec : BaselineSpec apply record where
  kept _ _ := rfl
  suppressed _ _ := rfl
  stale b vs x := by
    simp [apply, List.mem_filter, mem_dedup]
  staleUnique b vs := List.Pairwise.filter _ (nodup_dedup b)
  recorded vs x := by
    simp [record, mem_dedup]
  recordUnique vs := nodup_dedup _

/-! ## Examples -/

section Examples

open Archer

private def order : FilePath := ["src", "domain", "order.ts"]

private def forbidden (line : Nat) : Violation :=
  { ruleId := "no-infra"
    severity := .error
    subject := order
    evidence := .dependency
      { source := order
        dependency :=
          { target := .file ["src", "infra", "db.ts"]
            kind := .static
            specifier := "../infra/db"
            location := ⟨line, 1⟩ } } }

private def tooLong : Violation :=
  { ruleId := "max-lines", severity := .warning, subject := ["src", "big.ts"],
    evidence := .lines 900 }

/-- Backslashes, separators, and newlines in every position. -/
private def awkward : Fingerprint :=
  ⟨"a|b", ["x/y", "\\"], .custom "one\ntwo"⟩

/-- The fingerprint of `forbidden` ignores where the import sits. -/
example : (forbidden 3).fingerprint = (forbidden 9).fingerprint := rfl

example : encode (forbidden 3).fingerprint =
    "no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts" := by
  decide

example : encode tooLong.fingerprint = "max-lines|/src/big.ts|lines" := by decide

example : encode awkward = "a\\pb|/x\\\\sy/\\\\\\\\|custom|one\\ntwo" := by decide

example : encode ⟨"no-eval", ["src", "a.ts"], .use .call "eval" .global⟩ =
    "no-eval|/src/a.ts|use|call|eval|global" := by
  decide

example : encode ⟨"npm-only", ["src", "a.ts"],
    .dependency (.package "@scope/pkg" ["sub"]) "@scope/pkg/sub" .type⟩ =
    "npm-only|/src/a.ts|dependency|type|@scope/pkg/sub|package|@scope/pkg|/sub" := by
  decide

/-- An empty path is an empty field. -/
example : encode ⟨"r", [], .missing⟩ = "r||missing" := by decide

example : decode "r||missing" = some ⟨"r", [], .missing⟩ := by decide

example : decode (encode (forbidden 3).fingerprint) = some (forbidden 3).fingerprint := by
  decide

example : decode (encode awkward) = some awkward := by decide

example : decode "max-lines|/src/big.ts|lines" = some tooLong.fingerprint := by decide

example : decode "max-lines|/src/big.ts|nothing" = none := by decide

example : decode "a\\" = none := by decide

private def current : List Violation := [forbidden 3, forbidden 9, tooLong]

private def gone : Fingerprint := ⟨"gone", ["src", "old.ts"], .cycle⟩

example : record current = [(forbidden 3).fingerprint, tooLong.fingerprint] := by decide

example : (apply [tooLong.fingerprint, gone] current).kept = [forbidden 3, forbidden 9] := by
  decide

example : (apply [tooLong.fingerprint, gone] current).suppressed = [tooLong] := by decide

example : (apply [tooLong.fingerprint, gone, gone] current).stale = [gone] := by decide

example : (apply (record current) current).kept = [] := by decide

end Examples

end Archer.Impl

#print axioms Archer.Impl.encode_spec
#print axioms Archer.Impl.baseline_spec
