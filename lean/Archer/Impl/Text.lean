import Archer.Spec.Text

/-!
# Selector text

`parse` and `print` for the selector strings of `docs/contracts/selector-text.md`.
Contract: `Archer.Spec.TextSpec`. Everything works on `List Char`; `parse` and `print` only
convert at the boundary.

## `parse` algorithm (the TypeScript port follows this order)

1. The empty string is `empty`.
2. Brace expansion over the whole string (`expand`): a left-to-right scan with a stack of open
   groups. Nested groups flatten into one list of brace-free alternatives, in left-major
   order (`{a,b}{c,d}` gives `ac, ad, bc, bd`). A `}` or `,` with no open group, or a `{` left
   open at the end, is `unbalancedBraces`.
3. The alternatives are parsed left to right (`parseAll`); the first failing alternative
   decides the error. An alternative (`parseAlt`) is:
   - prefixed when it starts with the first matching entry of `Spec.prefixes`
     (`npm:`, `node:`, `bun:`, `layer:`, `unresolved:`, `computed:`). Any wrong or missing
     name is `invalidName` with the prefix (without the colon) and the name. The forms are
     never read as paths. `npm:*`, `node:*`, `bun:*` are the any-forms; `npm:` accepts
     `name` or `@scope/name` (non-empty parts, no other `/`); `node:`/`bun:` accept any
     non-empty name; `layer:` any non-empty name; `unresolved:` and `computed:` only `*`.
   - otherwise a path glob. Errors in this order: the first `\`, `[`, or `]` in the
     alternative is `unsupported`; then the first segment (after dropping a leading `./` and
     splitting on `/`) that is empty, `.`, or `..` is `invalidSegment` with its text. Tokens
     are `globTokens` of the segments, plus a final `**` when the alternative has no `*` or
     `?` (a plain path selects everything under it).
4. One alternative gives its selector; two or more give `any` of them (`finish`).

## `print`

`.any` with at least two members prints `{a,b,...}` of its members' texts; a member is a
prefixed form (printed as it is parsed) or a glob (segments joined by `/`, `**`, `*`, `?` for
`globstar`, `star`, `one`). A glob text gets a leading `./` only when it would otherwise read
as a prefixed form or begin with `./`. Selectors that `parse` never produces print as `none`
(`all`, `not`, nested `any`, `any` with fewer than two members); a bare glob that has no wildcard
token is not checked.
-/

namespace Archer.Impl

open Archer Archer.Spec

abbrev Frame := List (List Char) × List (List Char)

/-- The scan behind `expand`: `cur` holds the alternatives of the current group, `fs` the
enclosing groups (their alternatives so far, then the text before the group). -/
def expandGo : List Char → List (List Char) → List Frame → Except ParseError (List (List Char))
  | [], cur, [] => .ok cur
  | [], _, _ :: _ => .error .unbalancedBraces
  | c :: cs, cur, fs =>
    if c = '{' then expandGo cs [[]] ((cur, []) :: fs)
    else if c = ',' then
      match fs with
      | [] => .error .unbalancedBraces
      | (o, acc) :: fs' => expandGo cs [[]] ((o, acc ++ cur) :: fs')
    else if c = '}' then
      match fs with
      | [] => .error .unbalancedBraces
      | (o, acc) :: fs' => expandGo cs (o.flatMap fun u => (acc ++ cur).map (u ++ ·)) fs'
    else expandGo cs (cur.map (· ++ [c])) fs

/-- Brace expansion into brace-free alternatives; `unbalancedBraces` on a stray `}` or `,`,
or an unclosed `{`. -/
def expand (w : List Char) : Except ParseError (List (List Char)) := expandGo w [[]] []

/-- No `{`, `}`, or `,`. -/
def BFc (u : List Char) : Prop := ∀ c ∈ u, c ∉ braceChars

theorem expandGo_bf : ∀ (w r : List Char) (cur : List (List Char)) (fs : List Frame), BFc w →
    expandGo (w ++ r) cur fs = expandGo r (cur.map (· ++ w)) fs
  | [], r, cur, fs, _ => by simp
  | c :: cs, r, cur, fs, h => by
    have hc : c ≠ '{' ∧ c ≠ ',' ∧ c ≠ '}' := by
      have := h c (List.mem_cons_self ..)
      refine ⟨?_, ?_, ?_⟩ <;> intro e <;> simp_all [braceChars]
    have ih := expandGo_bf cs r (cur.map (· ++ [c])) fs (fun x hx => h x (List.mem_cons_of_mem _ hx))
    simp [expandGo, hc.1, hc.2.1, hc.2.2, ih, Function.comp_def]

theorem expand_bf (w : List Char) (h : BFc w) : expand w = .ok [w] := by
  have := expandGo_bf w [] [[]] [] h
  simpa [expand, expandGo] using this


/-- The alternatives joined by commas. -/
def joinComma : List Char → List (List Char) → List Char
  | x, [] => x
  | x, y :: ys => x ++ ',' :: joinComma y ys

theorem expandGo_group : ∀ (xs : List (List Char)) (x : List Char) (o acc : List (List Char))
    (fs : List Frame) (rest : List Char), BFc x → (∀ y ∈ xs, BFc y) →
    expandGo (joinComma x xs ++ '}' :: rest) [[]] ((o, acc) :: fs) =
      expandGo rest (o.flatMap fun u => (acc ++ x :: xs).map (u ++ ·)) fs
  | [], x, o, acc, fs, rest, hx, _ => by
    simp only [joinComma]
    rw [expandGo_bf x _ _ _ hx]
    simp [expandGo]
  | y :: ys, x, o, acc, fs, rest, hx, hy => by
    simp only [joinComma, List.append_assoc, List.cons_append]
    rw [expandGo_bf x _ _ _ hx]
    have ih := expandGo_group ys y o (acc ++ [x]) fs rest (hy y (List.mem_cons_self ..))
      (fun z hz => hy z (List.mem_cons_of_mem _ hz))
    simp only [expandGo, ite_true]
    simpa [Function.comp_def] using ih

theorem expand_group (pre post x : List Char) (xs : List (List Char)) (hp : BFc pre) (hq : BFc post)
    (hx : BFc x) (hxs : ∀ y ∈ xs, BFc y) :
    expand (pre ++ '{' :: joinComma x xs ++ '}' :: post) =
      .ok ((x :: xs).map fun m => pre ++ m ++ post) := by
  unfold expand
  rw [List.append_assoc, List.cons_append, expandGo_bf pre _ _ _ hp]
  simp only [expandGo, ite_true, List.map_cons, List.map_nil, List.nil_append]
  rw [expandGo_group xs x _ _ _ _ hx hxs]
  have h := expandGo_bf post [] (List.flatMap (fun u => List.map (fun x_1 => u ++ x_1) ([] ++ x :: xs)) [pre]) [] hq
  rw [List.append_nil] at h
  rw [h]
  simp [expandGo, Function.comp_def]

theorem BFc_append {u v : List Char} : BFc (u ++ v) ↔ BFc u ∧ BFc v := by
  simp only [BFc, List.mem_append]
  constructor
  · intro h; exact ⟨fun c hc => h c (Or.inl hc), fun c hc => h c (Or.inr hc)⟩
  · rintro ⟨h1, h2⟩ c (hc | hc)
    · exact h1 c hc
    · exact h2 c hc

/-- What the scan keeps true: every alternative is brace-free and no list is empty. -/
def ExpandInv (cur : List (List Char)) (fs : List Frame) : Prop :=
  cur ≠ [] ∧ (∀ u ∈ cur, BFc u) ∧
    ∀ f ∈ fs, f.1 ≠ [] ∧ (∀ u ∈ f.1, BFc u) ∧ ∀ u ∈ f.2, BFc u

theorem expandGo_inv : ∀ (w : List Char) (cur : List (List Char)) (fs : List Frame)
    (r : List (List Char)), expandGo w cur fs = .ok r → ExpandInv cur fs → r ≠ [] ∧ ∀ u ∈ r, BFc u
  | [], cur, [], r, h, hi => by
    simp only [expandGo, Except.ok.injEq] at h
    subst h; exact ⟨hi.1, hi.2.1⟩
  | [], cur, _ :: _, r, h, _ => by simp [expandGo] at h
  | c :: cs, cur, fs, r, h, hi => by
    obtain ⟨hne, hbf, hfs⟩ := hi
    by_cases h1 : c = '{'
    · simp only [expandGo, h1, ite_true] at h
      refine expandGo_inv cs _ _ r h ⟨by simp, by simp [BFc], ?_⟩
      intro f hf
      rcases List.mem_cons.1 hf with rfl | hf
      · exact ⟨hne, hbf, by simp⟩
      · exact hfs f hf
    by_cases h2 : c = ','
    · rcases fs with _ | ⟨⟨o, acc⟩, fs'⟩
      · simp [expandGo, h2] at h
      · simp only [expandGo, h2, ite_true] at h
        obtain ⟨g1, g2, g3⟩ := hfs (o, acc) (by simp)
        refine expandGo_inv cs _ _ r h ⟨by simp, by simp [BFc], ?_⟩
        intro f hf
        rcases List.mem_cons.1 hf with rfl | hf
        · refine ⟨g1, g2, ?_⟩
          intro u hu
          rcases List.mem_append.1 hu with hu | hu
          · exact g3 u hu
          · exact hbf u hu
        · exact hfs f (by simp [hf])
    by_cases h3 : c = '}'
    · rcases fs with _ | ⟨⟨o, acc⟩, fs'⟩
      · simp [expandGo, h3] at h
      · subst h3
        simp only [expandGo, h1, h2, ite_true, ite_false] at h
        obtain ⟨g1, g2, g3⟩ := hfs (o, acc) (by simp)
        refine expandGo_inv cs _ _ r h ⟨?_, ?_, ?_⟩
        · intro e
          rcases List.flatMap_eq_nil_iff.1 e with e
          obtain ⟨u, hu⟩ := List.exists_mem_of_ne_nil _ g1
          have := e u hu
          simp at this
          exact hne this.2
        · intro u hu
          obtain ⟨a, ha, hu⟩ := List.mem_flatMap.1 hu
          obtain ⟨b, hb, rfl⟩ := List.mem_map.1 hu
          refine BFc_append.2 ⟨g2 a ha, ?_⟩
          rcases List.mem_append.1 hb with hb | hb
          · exact g3 b hb
          · exact hbf b hb
        · intro f hf; exact hfs f (by simp [hf])
    · simp only [expandGo, h1, h2, h3, ite_false] at h
      refine expandGo_inv cs _ _ r h ⟨by simpa using hne, ?_, hfs⟩
      intro u hu
      obtain ⟨a, ha, rfl⟩ := List.mem_map.1 hu
      refine BFc_append.2 ⟨hbf a ha, ?_⟩
      intro d hd
      simp at hd; subst hd
      simp [braceChars]
      exact ⟨h1, h3, h2⟩


theorem splitOn_nil : ([] : List Char).splitOn '/' = [[]] := by
  simp [List.splitOn, List.splitOnP, List.splitOnPPrepend]

theorem splitOn_cons (c : Char) (cs : List Char) :
    (c :: cs).splitOn '/' =
      if c = '/' then [] :: cs.splitOn '/' else (cs.splitOn '/').modifyHead (c :: ·) := by
  simp only [List.splitOn]
  rw [List.splitOnP_cons_eq_ite_modifyHead]
  simp

theorem splitOn_ne (l : List Char) : ∃ x xs, l.splitOn '/' = x :: xs := by
  induction l with
  | nil => exact ⟨[], [], splitOn_nil⟩
  | cons c cs ih =>
    obtain ⟨x, xs, h⟩ := ih
    rw [splitOn_cons]
    by_cases hc : c = '/'
    · exact ⟨[], x :: xs, by simp [hc, h]⟩
    · exact ⟨c :: x, xs, by simp [hc, h, List.modifyHead]⟩

theorem splitOn_single : ∀ x : List Char, '/' ∉ x → x.splitOn '/' = [x]
  | [], _ => splitOn_nil
  | c :: cs, h => by
    have hc : c ≠ '/' := fun e => h (e ▸ List.mem_cons_self ..)
    have ih := splitOn_single cs (fun e => h (List.mem_cons_of_mem _ e))
    simp [splitOn_cons, hc, ih, List.modifyHead]

theorem splitOn_snoc (x : List Char) (hx : '/' ∉ x) : ∀ l : List Char,
    (l ++ '/' :: x).splitOn '/' = l.splitOn '/' ++ [x]
  | [] => by simp [splitOn_cons, splitOn_single x hx]
  | c :: cs => by
    have ih := splitOn_snoc x hx cs
    obtain ⟨y, ys, hy⟩ := splitOn_ne cs
    by_cases hc : c = '/'
    · simp [splitOn_cons, hc, ih]
    · simp [splitOn_cons, hc, ih, hy, List.modifyHead]

theorem mem_of_mem_splitOn : ∀ (l : List Char) (x : List Char), x ∈ l.splitOn '/' →
    '/' ∉ x ∧ ∀ c ∈ x, c ∈ l
  | [], x, h => by
    simp at h; subst h; simp
  | c :: cs, x, h => by
    have ih := mem_of_mem_splitOn cs
    obtain ⟨y, ys, hy⟩ := splitOn_ne cs
    by_cases hc : c = '/'
    · simp only [splitOn_cons, hc, ite_true, List.mem_cons] at h
      rcases h with rfl | h
      · simp
      · obtain ⟨h1, h2⟩ := ih x h
        exact ⟨h1, fun d hd => List.mem_cons_of_mem _ (h2 d hd)⟩
    · simp only [splitOn_cons, hc, ite_false, hy, List.modifyHead, List.mem_cons] at h
      rcases h with rfl | h
      · obtain ⟨h1, h2⟩ := ih y (by simp [hy])
        refine ⟨?_, ?_⟩
        · simp [h1]; exact fun e => hc e.symm
        · intro d hd
          rcases List.mem_cons.1 hd with rfl | hd
          · exact List.mem_cons_self ..
          · exact List.mem_cons_of_mem _ (h2 d hd)
      · obtain ⟨h1, h2⟩ := ih x (by simp [hy, h])
        exact ⟨h1, fun d hd => List.mem_cons_of_mem _ (h2 d hd)⟩

/-- Segments joined by `/`. -/
def joinSlash : List (List Char) → List Char
  | [] => []
  | [x] => x
  | x :: y :: ys => x ++ '/' :: joinSlash (y :: ys)

theorem joinSlash_snoc (x : List Char) : ∀ L : List (List Char), L ≠ [] →
    joinSlash (L ++ [x]) = joinSlash L ++ '/' :: x
  | [], h => absurd rfl h
  | [y], _ => by simp [joinSlash]
  | y :: z :: zs, _ => by
    have ih := joinSlash_snoc x (z :: zs) (by simp)
    simp only [List.cons_append] at ih ⊢
    simp [joinSlash, ih]

theorem joinSlash_splitOn : ∀ l : List Char, joinSlash (l.splitOn '/') = l
  | [] => by simp [joinSlash]
  | c :: cs => by
    have ih := joinSlash_splitOn cs
    obtain ⟨y, ys, hy⟩ := splitOn_ne cs
    rw [hy] at ih
    by_cases hc : c = '/'
    · simp [splitOn_cons, hc, hy, joinSlash, ih]
    · simp only [splitOn_cons, hc, ite_false, hy, List.modifyHead]
      cases ys with
      | nil => simpa [joinSlash] using ih
      | cons z zs => simp [joinSlash] at ih ⊢; simp [ih]

/-- Drops a leading `./`. -/
def dotStrip : List Char → List Char
  | '.' :: '/' :: r => r
  | a => a

/-- An empty, `.`, or `..` segment. -/
def invalidSeg (s : List Char) : Bool := decide (s = [] ∨ s = ['.'] ∨ s = ['.', '.'])

/-- The text has a `*` or `?`. -/
def isWild (b : List Char) : Bool := b.any fun c => c == '*' || c == '?'

/-- The rest of the text after a prefix, if it starts with it. -/
def dropPre : List Char → List Char → Option (List Char)
  | [], r => some r
  | _ :: _, [] => none
  | p :: ps, c :: cs => if p = c then dropPre ps cs else none

/-- The first entry of `Spec.prefixes` that the text starts with, and the rest. -/
def prefixOf (a : List Char) : Option (String × List Char) :=
  prefixes.findSome? fun p => (dropPre p.toList a).map (p, ·)

/-- A brace-free path glob. -/
def parsePath (a : List Char) : Except ParseError ConfigSelector :=
  match a.find? fun c => decide (c ∈ unsupportedChars) with
  | some c => .error (.unsupported c)
  | none =>
    let b := dotStrip a
    let segs := b.splitOn '/'
    match segs.find? invalidSeg with
    | some s => .error (.invalidSegment (String.ofList s))
    | none =>
      .ok (.base (.glob (globTokens (segs.map String.ofList) ++
        if isWild b then [] else [.globstar])))

/-- A non-empty package name without `/`, or `@scope/name`. -/
def validPackage (rest : List Char) : Bool :=
  !rest.isEmpty &&
    match rest.takeWhile (· != '/'), rest.dropWhile (· != '/') with
    | _, [] => true
    | '@' :: _ :: _, '/' :: pkg => !pkg.isEmpty && !pkg.contains '/'
    | _, _ => false

/-- `node:` and `bun:` names. -/
def builtinForm (runtime : Runtime) (kind : String) (rest : List Char) :
    Except ParseError ConfigSelector :=
  if rest = ['*'] then .ok (.base (.builtin runtime none))
  else if rest = [] then .error (.invalidName kind "")
  else .ok (.base (.builtin runtime (some (String.ofList rest))))

/-- A prefixed alternative; every failure is `invalidName`. -/
def parsePrefixed (p : String) (rest : List Char) : Except ParseError ConfigSelector :=
  if p = "npm:" then
    if rest = ['*'] then .ok (.base (.package none))
    else if validPackage rest then .ok (.base (.package (some (String.ofList rest))))
    else .error (.invalidName "npm" (String.ofList rest))
  else if p = "node:" then builtinForm .node "node" rest
  else if p = "bun:" then builtinForm .bun "bun" rest
  else if p = "layer:" then
    if rest = [] then .error (.invalidName "layer" "") else .ok (.layer (String.ofList rest))
  else if p = "unresolved:" then
    if rest = ['*'] then .ok (.base .unresolved)
    else .error (.invalidName "unresolved" (String.ofList rest))
  else
    if rest = ['*'] then .ok (.base .computed)
    else .error (.invalidName "computed" (String.ofList rest))

/-- One brace-free alternative. -/
def parseAlt (a : List Char) : Except ParseError ConfigSelector :=
  match prefixOf a with
  | some (p, rest) => parsePrefixed p rest
  | none => parsePath a

/-- Every alternative, failing with the first error. -/
def parseAll : List (List Char) → Except ParseError (List ConfigSelector)
  | [] => .ok []
  | a :: as =>
    match parseAlt a with
    | .error e => .error e
    | .ok s =>
      match parseAll as with
      | .error e => .error e
      | .ok ss => .ok (s :: ss)

/-- One alternative is itself, several are `any`. -/
def finish : List ConfigSelector → ConfigSelector
  | [s] => s
  | ss => .any ss

/-- The whole parse on characters. -/
def parseChars (w : List Char) : Except ParseError ConfigSelector :=
  if w = [] then .error .empty
  else
    match expand w with
    | .error e => .error e
    | .ok r =>
      match parseAll r with
      | .error e => .error e
      | .ok ss => .ok (finish ss)

/-- Selector text to selector. -/
def parse : ParseFn := fun text => parseChars text.toList

/-- The text of a segment's tokens. -/
def renderSeg : List SegmentToken → List Char
  | [] => []
  | .literal c :: ts => c :: renderSeg ts
  | .one :: ts => '?' :: renderSeg ts
  | .star :: ts => '*' :: renderSeg ts

/-- The text of a path token. -/
def renderTok : PathToken → List Char
  | .segment ts => renderSeg ts
  | .globstar => ['*', '*']

/-- Prefixes `./` when the text would otherwise read as a prefixed form or lose a leading
`./`. -/
def guardDot (body : List Char) : List Char :=
  if prefixOf body = none ∧ dotStrip body = body then body else '.' :: '/' :: body

/-- The text of a selector that `parseAlt` produces. -/
def print1 : ConfigSelector → Option (List Char)
  | .base (.glob ts) => some (guardDot (joinSlash (ts.map renderTok)))
  | .base (.package none) => some "npm:*".toList
  | .base (.package (some n)) => some ("npm:".toList ++ n.toList)
  | .base (.builtin .node none) => some "node:*".toList
  | .base (.builtin .node (some n)) => some ("node:".toList ++ n.toList)
  | .base (.builtin .bun none) => some "bun:*".toList
  | .base (.builtin .bun (some n)) => some ("bun:".toList ++ n.toList)
  | .base .unresolved => some "unresolved:*".toList
  | .base .computed => some "computed:*".toList
  | .layer n => some ("layer:".toList ++ n.toList)
  | _ => none

/-- The texts of several selectors. -/
def printAll : List ConfigSelector → Option (List (List Char))
  | [] => some []
  | s :: ss =>
    match print1 s with
    | none => none
    | some t =>
      match printAll ss with
      | none => none
      | some ts => some (t :: ts)

/-- Selector to text; `none` for selectors that `parse` never produces. -/
def print : PrintFn
  | .any (a :: b :: rest) =>
    match print1 a with
    | none => none
    | some t =>
      match printAll (b :: rest) with
      | none => none
      | some ts => some (String.ofList ('{' :: joinComma t ts ++ ['}']))
  | s => (print1 s).map String.ofList

theorem dropPre_eq : ∀ (p c r : List Char), dropPre p c = some r ↔ p ++ r = c
  | [], c, r => by simp [dropPre, eq_comm]
  | _ :: _, [], r => by simp [dropPre]
  | x :: xs, y :: ys, r => by
    have ih := dropPre_eq xs ys r
    by_cases h : x = y
    · subst h; simp [dropPre, ih]
    · simp [dropPre, h]

theorem prefixOf_none (a : List Char) :
    prefixOf a = none ↔ ∀ p ∈ prefixes, ¬ p.toList.IsPrefix a := by
  unfold prefixOf
  rw [List.findSome?_eq_none_iff]
  refine forall₂_congr fun p hp => ?_
  rw [Option.map_eq_none_iff, ← Option.not_isSome_iff_eq_none, Option.isSome_iff_exists]
  constructor
  · intro h ⟨t, ht⟩; exact h ⟨t, (dropPre_eq _ _ _).2 ht⟩
  · intro h ⟨t, ht⟩; exact h ⟨t, (dropPre_eq _ _ _).1 ht⟩

theorem prefixOf_some {a : List Char} {p : String} {r : List Char} (h : prefixOf a = some (p, r)) :
    p ∈ prefixes ∧ p.toList ++ r = a := by
  unfold prefixOf at h
  obtain ⟨q, hq, h⟩ := List.exists_of_findSome?_eq_some h
  simp only [Option.map_eq_some_iff, Prod.mk.injEq] at h
  obtain ⟨t, ht, rfl, rfl⟩ := h
  exact ⟨hq, (dropPre_eq _ _ _).1 ht⟩


theorem prefixOf_append {p : String} (hp : p ∈ prefixes) (r : List Char) :
    prefixOf (p.toList ++ r) = some (p, r) := by
  simp only [prefixes, List.mem_cons, List.not_mem_nil, or_false] at hp
  rcases hp with rfl | rfl | rfl | rfl | rfl | rfl <;> simp [prefixOf, prefixes, dropPre]

theorem prefixOf_dot (r : List Char) : prefixOf ('.' :: r) = none := by
  rw [prefixOf_none]; simp [prefixes]

/-- The selector of a glob text with its leading `./` already dropped. -/
def pathSel (b : List Char) : ConfigSelector :=
  .base (.glob (globTokens ((b.splitOn '/').map String.ofList) ++
    if isWild b then [] else [.globstar]))

/-- The text that `print` writes for the glob selector of `pathSel b`. -/
def pathText (b : List Char) : List Char := if isWild b then b else b ++ ['/', '*', '*']

theorem parsePath_eq (a : List Char) (hu : ∀ c ∈ a, c ∉ unsupportedChars)
    (hv : ∀ x ∈ (dotStrip a).splitOn '/', ¬ invalidSeg x = true) :
    parsePath a = .ok (pathSel (dotStrip a)) := by
  have h1 : a.find? (fun c => decide (c ∈ unsupportedChars)) = none := by
    rw [List.find?_eq_none]; intro c hc; simpa using hu c hc
  have h2 := List.find?_eq_none.2 hv
  simp [parsePath, h1, h2, pathSel]

theorem parsePath_ok {a : List Char} {s : ConfigSelector} (h : parsePath a = .ok s) :
    (∀ c ∈ a, c ∉ unsupportedChars) ∧ (∀ x ∈ (dotStrip a).splitOn '/', ¬ invalidSeg x = true) ∧
      s = pathSel (dotStrip a) := by
  unfold parsePath at h
  cases h1 : a.find? (fun c => decide (c ∈ unsupportedChars)) with
  | some c => simp [h1] at h
  | none =>
    cases h2 : ((dotStrip a).splitOn '/').find? invalidSeg with
    | some x => simp [h1, h2] at h
    | none =>
      simp only [h1, h2, Except.ok.injEq] at h
      refine ⟨?_, ?_, h.symm⟩
      · intro c hc; have := (List.find?_eq_none.1 h1) c hc; simpa using this
      · exact List.find?_eq_none.1 h2

theorem parsePath_unsupported {a : List Char} {c : Char} (hc : c ∈ a) (hu : c ∈ unsupportedChars) :
    ∃ c', parsePath a = .error (.unsupported c') := by
  unfold parsePath
  cases h1 : a.find? (fun c => decide (c ∈ unsupportedChars)) with
  | some c' => exact ⟨c', by simp⟩
  | none =>
    have := (List.find?_eq_none.1 h1) c hc
    simp [hu] at this

theorem parsePath_invalid {a : List Char} (hu : ∀ c ∈ a, c ∉ unsupportedChars)
    (hv : ¬ ∀ x ∈ (dotStrip a).splitOn '/', ¬ invalidSeg x = true) :
    ∃ seg, parsePath a = .error (.invalidSegment seg) := by
  have h1 : a.find? (fun c => decide (c ∈ unsupportedChars)) = none := by
    rw [List.find?_eq_none]; intro c hc; simpa using hu c hc
  unfold parsePath
  cases h2 : ((dotStrip a).splitOn '/').find? invalidSeg with
  | some x => exact ⟨String.ofList x, by simp [h1, h2]⟩
  | none => exact absurd (List.find?_eq_none.1 h2) hv

theorem renderTok_segmentTokens (s : String) : renderTok (segmentTokens s) = s.toList := by
  unfold segmentTokens renderTok
  generalize s.toList = l
  induction l with
  | nil => rfl
  | cons c cs ih =>
    by_cases h1 : c = '*'
    · subst h1; simp [renderSeg, ih]
    · by_cases h2 : c = '?'
      · subst h2; simp [renderSeg, ih]
      · simp [renderSeg, ih]

theorem map_render_globTokens : ∀ strs : List String,
    (globTokens strs).map renderTok = strs.map String.toList
  | [] => rfl
  | s :: ss => by
    have ih := map_render_globTokens ss
    by_cases h : s = "**"
    · subst h
      simp only [globTokens, List.map_cons] at ih ⊢
      simp [ih, renderTok]
    · simp only [globTokens, List.map_cons] at ih ⊢
      simp [h, ih, renderTok_segmentTokens]

theorem ofList_stars : String.ofList ['*', '*'] = "**" := by decide

theorem print1_pathSel (b : List Char) : print1 (pathSel b) = some (guardDot (pathText b)) := by
  have hne : ∃ x xs, b.splitOn '/' = x :: xs := splitOn_ne b
  obtain ⟨x, xs, hx⟩ := hne
  by_cases hw : isWild b = true
  · simp [pathSel, pathText, hw, print1, map_render_globTokens, List.map_map, Function.comp_def,
      joinSlash_splitOn]
  · simp [pathSel, pathText, hw, print1, map_render_globTokens, List.map_map, Function.comp_def]
    rw [joinSlash_snoc _ _ (by simp [hx]), joinSlash_splitOn]
    rfl

theorem dotStrip_cases (a : List Char) :
    (∃ r, a = '.' :: '/' :: r ∧ dotStrip a = r) ∨ dotStrip a = a := by
  rcases a with _ | ⟨x, _ | ⟨y, r⟩⟩
  · right; rfl
  · right; simp [dotStrip]
  · by_cases h : x = '.' ∧ y = '/'
    · obtain ⟨rfl, rfl⟩ := h
      left; exact ⟨r, rfl, rfl⟩
    · right
      unfold dotStrip
      split
      · simp_all
      · rfl

theorem mem_dotStrip {c : Char} {a : List Char} (h : c ∈ dotStrip a) : c ∈ a := by
  rcases dotStrip_cases a with ⟨r, rfl, e⟩ | e
  · rw [e] at h; simp [h]
  · rwa [e] at h

theorem mem_dotStrip' {c : Char} {a : List Char} (h1 : c ≠ '.') (h2 : c ≠ '/') (h : c ∈ a) :
    c ∈ dotStrip a := by
  rcases dotStrip_cases a with ⟨r, rfl, e⟩ | e
  · rw [e]; simp at h; rcases h with h | h | h
    · exact absurd h h1
    · exact absurd h h2
    · exact h
  · rwa [e]

theorem globTokens_append (xs ys : List String) : globTokens (xs ++ ys) = globTokens xs ++ globTokens ys := by
  simp [globTokens]

theorem reparse_core (b t : List Char) (ht : dotStrip t = pathText b) (hpn : prefixOf t = none)
    (hu : ∀ c ∈ t, c ∉ unsupportedChars) (hv : ∀ x ∈ b.splitOn '/', ¬ invalidSeg x = true) :
    parseAlt t = .ok (pathSel b) := by
  unfold parseAlt
  rw [hpn]
  show parsePath t = _
  by_cases hw : isWild b = true
  · have hpt : pathText b = b := by simp [pathText, hw]
    rw [parsePath_eq _ hu, ht, hpt]
    rw [hpt] at ht
    simpa [ht] using hv
  · have hpt : pathText b = b ++ '/' :: ['*', '*'] := by simp [pathText, hw]
    have hseg : (b ++ '/' :: ['*', '*']).splitOn '/' = b.splitOn '/' ++ [['*', '*']] :=
      splitOn_snoc _ (by simp) b
    have hv' : ∀ x ∈ (dotStrip t).splitOn '/', ¬ invalidSeg x = true := by
      intro x hx
      simp only [ht, hpt, hseg, List.mem_append, List.mem_singleton] at hx
      rcases hx with hx | rfl
      · exact hv x hx
      · decide
    rw [parsePath_eq _ hu hv']
    simp only [ht, hpt, hseg, pathSel]
    have : isWild (b ++ '/' :: ['*', '*']) = true := by simp [isWild]
    simp [this, hw, globTokens]

theorem pathSel_reparse (b : List Char) (hu : ∀ c ∈ b, c ∉ unsupportedChars)
    (hv : ∀ x ∈ b.splitOn '/', ¬ invalidSeg x = true) :
    parseAlt (guardDot (pathText b)) = .ok (pathSel b) := by
  have hall : ∀ c ∈ pathText b, c ∉ unsupportedChars := by
    intro c hc
    unfold pathText at hc
    split at hc
    · exact hu c hc
    · simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hc
      rcases hc with hc | rfl | rfl | rfl
      · exact hu c hc
      all_goals simp [unsupportedChars]
  unfold guardDot
  by_cases hg : prefixOf (pathText b) = none ∧ dotStrip (pathText b) = pathText b
  · simp only [hg, and_self, ite_true]
    exact reparse_core b _ hg.2 hg.1 hall hv
  · simp only [hg, ite_false]
    refine reparse_core b _ rfl (prefixOf_dot _) ?_ hv
    intro c hc
    simp only [List.mem_cons] at hc
    rcases hc with rfl | rfl | hc
    · simp [unsupportedChars]
    · simp [unsupportedChars]
    · exact hall c hc

theorem print1_prefixed {a : List Char} {s : ConfigSelector} {p : String} {rest : List Char}
    (hp : prefixOf a = some (p, rest)) (h : parsePrefixed p rest = .ok s) : print1 s = some a := by
  obtain ⟨hmem, happ⟩ := prefixOf_some hp
  subst happ
  simp only [prefixes, List.mem_cons, List.not_mem_nil, or_false] at hmem
  rcases hmem with rfl | rfl | rfl | rfl | rfl | rfl
  · unfold parsePrefixed at h
    by_cases h1 : rest = ['*']
    · subst h1; simp at h; subst h; decide
    · by_cases h2 : validPackage rest = true
      · simp [h1, h2] at h; subst h; simp [print1]
      · simp [h1, h2] at h
  · simp [parsePrefixed, builtinForm] at h
    by_cases h1 : rest = ['*']
    · subst h1; simp at h; subst h; decide
    · by_cases h2 : rest = []
      · simp [h2] at h
      · simp [h1, h2] at h; subst h; simp [print1]
  · simp [parsePrefixed, builtinForm] at h
    by_cases h1 : rest = ['*']
    · subst h1; simp at h; subst h; decide
    · by_cases h2 : rest = []
      · simp [h2] at h
      · simp [h1, h2] at h; subst h; simp [print1]
  · simp [parsePrefixed] at h
    by_cases h2 : rest = []
    · simp [h2] at h
    · simp [h2] at h; subst h; simp [print1]
  · simp [parsePrefixed] at h
    by_cases h1 : rest = ['*']
    · subst h1; simp at h; subst h; decide
    · simp [h1] at h
  · simp [parsePrefixed] at h
    by_cases h1 : rest = ['*']
    · subst h1; simp at h; subst h; decide
    · simp [h1] at h

inductive Pairs {α β : Type} (R : α → β → Prop) : List α → List β → Prop where
  | nil : Pairs R [] []
  | cons {a b as bs} : R a b → Pairs R as bs → Pairs R (a :: as) (b :: bs)


theorem parseAlt_print {a : List Char} {s : ConfigSelector} (hb : BFc a)
    (h : parseAlt a = .ok s) : ∃ t, print1 s = some t ∧ BFc t ∧ parseAlt t = .ok s := by
  unfold parseAlt at h
  cases hp : prefixOf a with
  | some pr =>
    obtain ⟨p, rest⟩ := pr
    rw [hp] at h
    exact ⟨a, print1_prefixed hp h, hb, by unfold parseAlt; rw [hp]; exact h⟩
  | none =>
    rw [hp] at h
    obtain ⟨hu, hv, rfl⟩ := parsePath_ok h
    have hu' : ∀ c ∈ dotStrip a, c ∉ unsupportedChars := fun c hc => hu c (mem_dotStrip hc)
    refine ⟨_, print1_pathSel _, ?_, pathSel_reparse _ hu' hv⟩
    intro c hc
    have hcb : c ∈ dotStrip a → c ∉ braceChars := fun h => hb c (mem_dotStrip h)
    have hpt : c ∈ pathText (dotStrip a) → c ∉ braceChars := by
      intro hc
      unfold pathText at hc
      split at hc
      · exact hcb hc
      · simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hc
        rcases hc with hc | rfl | rfl | rfl
        · exact hcb hc
        all_goals simp [braceChars]
    unfold guardDot at hc
    split at hc
    · exact hpt hc
    · simp only [List.mem_cons] at hc
      rcases hc with rfl | rfl | hc
      · simp [braceChars]
      · simp [braceChars]
      · exact hpt hc

theorem parseAlt_nil : ∀ s, parseAlt [] ≠ .ok s := by
  intro s h
  have : parseAlt [] = .error (.invalidSegment "") := by
    simp [parseAlt, prefixOf, prefixes, dropPre, parsePath, invalidSeg, dotStrip]
  rw [this] at h; cases h

theorem parseAll_forall2 : ∀ (r : List (List Char)) (ss : List ConfigSelector),
    parseAll r = .ok ss → Pairs (fun a s => parseAlt a = .ok s) r ss
  | [], ss, h => by
    simp only [parseAll, Except.ok.injEq] at h; subst h; exact .nil
  | a :: as, ss, h => by
    unfold parseAll at h
    cases h1 : parseAlt a with
    | error e => simp [h1] at h
    | ok s0 =>
      cases h2 : parseAll as with
      | error e => simp [h1, h2] at h
      | ok ss' =>
        simp only [h1, h2, Except.ok.injEq] at h
        subst h
        exact .cons h1 (parseAll_forall2 as ss' h2)

theorem forall2_parseAll : ∀ (r : List (List Char)) (ss : List ConfigSelector),
    Pairs (fun a s => parseAlt a = .ok s) r ss → parseAll r = .ok ss
  | _, _, .nil => rfl
  | _, _, .cons h1 h2 => by
    simp [parseAll, h1, forall2_parseAll _ _ h2]

theorem parseChars_bf (w : List Char) (hb : BFc w) (hne : w ≠ []) : parseChars w = parseAlt w := by
  unfold parseChars
  simp only [hne, ite_false]
  simp only [expand_bf w hb]
  cases h : parseAlt w <;> simp [parseAll, h, finish]

theorem printAll_forall2 : ∀ (ss : List ConfigSelector) (rs : List (List Char)),
    Pairs (fun a s => parseAlt a = .ok s) rs ss → (∀ a ∈ rs, BFc a) →
    ∃ ts, printAll ss = some ts ∧
      Pairs (fun t s => BFc t ∧ parseAlt t = .ok s) ts ss
  | _, _, .nil, _ => ⟨[], rfl, .nil⟩
  | _, _, .cons (a := a) (b := s) h1 h2, hb => by
    obtain ⟨t, ht, hbt, hpt⟩ := parseAlt_print (hb a (List.mem_cons_self ..)) h1
    obtain ⟨ts, hts, hF⟩ := printAll_forall2 _ _ h2 (fun x hx => hb x (List.mem_cons_of_mem _ hx))
    exact ⟨t :: ts, by simp [printAll, ht, hts], .cons ⟨hbt, hpt⟩ hF⟩

theorem printAll_cons {s : ConfigSelector} {ss : List ConfigSelector} {l : List (List Char)}
    (h : printAll (s :: ss) = some l) :
    ∃ t ts, print1 s = some t ∧ printAll ss = some ts ∧ l = t :: ts := by
  unfold printAll at h
  cases h1 : print1 s with
  | none => simp [h1] at h
  | some t =>
    cases h2 : printAll ss with
    | none => simp [h1, h2] at h
    | some ts => simp [h1, h2] at h; exact ⟨t, ts, rfl, rfl, h.symm⟩

theorem forall2_bf : ∀ {ts : List (List Char)} {ss : List ConfigSelector},
    Pairs (fun t s => BFc t ∧ parseAlt t = .ok s) ts ss → ∀ y ∈ ts, BFc y
  | _, _, .nil => by simp
  | _, _, .cons h1 h2 => by
    intro y hy
    rcases List.mem_cons.1 hy with rfl | hy
    · exact h1.1
    · exact forall2_bf h2 y hy

theorem forall2_alt : ∀ {ts : List (List Char)} {ss : List ConfigSelector},
    Pairs (fun t s => BFc t ∧ parseAlt t = .ok s) ts ss →
    Pairs (fun a s => parseAlt a = .ok s) ts ss
  | _, _, .nil => .nil
  | _, _, .cons h1 h2 => .cons h1.2 (forall2_alt h2)

theorem print_of_print1 {s : ConfigSelector} {t : List Char} (h : print1 s = some t) :
    print s = some (String.ofList t) := by
  cases s with
  | any l => simp [print1] at h
  | base x => simp [print, h]
  | layer n => simp [print, h]
  | all l => simp [print1] at h
  | not x => simp [print1] at h


theorem parseChars_ok {w : List Char} {s : ConfigSelector} (h : parseChars w = .ok s) :
    w ≠ [] ∧ ∃ r ss, expand w = .ok r ∧ parseAll r = .ok ss ∧ s = finish ss := by
  unfold parseChars at h
  by_cases hw : w = []
  · simp [hw] at h
  · simp only [hw, ite_false] at h
    refine ⟨hw, ?_⟩
    cases he : expand w with
    | error e => simp [he] at h
    | ok r =>
      cases hp : parseAll r with
      | error e => simp [he, hp] at h
      | ok ss => simp [he, hp] at h; exact ⟨r, ss, rfl, hp, h.symm⟩

/-- S1. -/
theorem parse_roundTrip : ∀ text s, parse text = .ok s →
    ∃ text', print s = some text' ∧ parse text' = .ok s := by
  intro text s h
  obtain ⟨hw, r, ss, he, hp, rfl⟩ := parseChars_ok h
  obtain ⟨hne, hbf⟩ := expandGo_inv _ _ _ r he ⟨by simp, by simp [BFc], by simp⟩
  have hF := parseAll_forall2 r ss hp
  have hall : ∀ a ∈ r, BFc a := hbf
  cases hF with
  | nil => exact absurd rfl hne
  | cons h1 h2 =>
    rename_i a s0 as ss'
    cases h2 with
    | nil =>
      obtain ⟨t, ht, hbt, hpt⟩ := parseAlt_print (hall a (List.mem_cons_self ..)) h1
      refine ⟨String.ofList t, print_of_print1 ht, ?_⟩
      have htne : t ≠ [] := by
        rintro rfl; exact parseAlt_nil _ hpt
      show parseChars (String.ofList t).toList = _
      rw [String.toList_ofList, parseChars_bf t hbt htne, hpt]
      rfl
    | cons h3 h4 =>
      rename_i b s1 bs ss''
      obtain ⟨ts, hts, hF⟩ := printAll_forall2 (s0 :: s1 :: ss'') (a :: b :: bs)
        (.cons h1 (.cons h3 h4)) hall
      obtain ⟨t0, tsr, h0, hr, rfl⟩ := printAll_cons hts
      cases hF with
      | cons g0 g1 =>
        have hbfs := forall2_bf g1
        have hfin : finish (s0 :: s1 :: ss'') = .any (s0 :: s1 :: ss'') := rfl
        rw [hfin]
        refine ⟨String.ofList ('{' :: joinComma t0 tsr ++ ['}']), ?_, ?_⟩
        · simp [print, h0, hr]
        · show parseChars (String.ofList _).toList = _
          rw [String.toList_ofList]
          have hex := expand_group [] [] t0 tsr (by simp [BFc]) (by simp [BFc]) g0.1 hbfs
          simp only [List.nil_append, List.append_nil, List.map_id'] at hex
          unfold parseChars
          have hnz : ('{' :: joinComma t0 tsr ++ ['}']) ≠ [] := by simp
          simp only [hnz, ite_false]
          simp only [List.cons_append] at hex ⊢
          rw [hex]
          dsimp only
          rw [forall2_parseAll _ _ (.cons g0.2 (forall2_alt g1))]
          rfl


theorem parse_bf (text : String) (hb : BraceFree text) (hne : text.toList ≠ []) :
    parse text = parseAlt text.toList := parseChars_bf _ hb hne

theorem string_ne_nil {t : String} (h : t ≠ "") : t.toList ≠ [] := by
  intro e; apply h; simpa using e

theorem takeWhile_split (r : List Char) : ∀ x : List Char, '/' ∉ x →
    (x ++ '/' :: r).takeWhile (· != '/') = x ∧ (x ++ '/' :: r).dropWhile (· != '/') = '/' :: r
  | [], _ => by simp
  | c :: cs, h => by
    have hc : c ≠ '/' := fun e => h (e ▸ List.mem_cons_self ..)
    have ih := takeWhile_split r cs (fun e => h (List.mem_cons_of_mem _ e))
    simp [hc, ih.1, ih.2]

theorem dropWhile_none : ∀ x : List Char, '/' ∉ x → x.dropWhile (· != '/') = []
  | [], _ => rfl
  | c :: cs, h => by
    have hc : c ≠ '/' := fun e => h (e ▸ List.mem_cons_self ..)
    simp [hc, dropWhile_none cs (fun e => h (List.mem_cons_of_mem _ e))]

theorem validPackage_of {name : String} (h : ValidPackageName name) :
    validPackage name.toList = true := by
  obtain ⟨_, hne, _, h | ⟨scope, pkg, he, hs, hp, hs', hp'⟩⟩ := h
  · have : name.toList ≠ [] := string_ne_nil hne
    simp [validPackage, dropWhile_none _ h, this]
  · rw [he]
    obtain ⟨x, xs, rfl⟩ := List.exists_cons_of_ne_nil hs
    have h2 : '/' ∉ '@' :: x :: xs := by
      simp only [List.mem_cons, not_or] at hs' ⊢
      exact ⟨by decide, hs'⟩
    have := takeWhile_split pkg ('@' :: x :: xs) h2
    simp only [List.cons_append] at this ⊢
    obtain ⟨p, ps, rfl⟩ := List.exists_cons_of_ne_nil hp
    simp [validPackage, this.1, this.2]
    simpa using hp'

/-- S5, `npm:` names. -/
theorem parse_npm_ok (name : String) (h : ValidPackageName name) :
    parse ("npm:" ++ name) = .ok (.base (.package (some name))) := by
  have hbf := h.1
  have hne := h.2.1
  have hs := h.2.2.1
  have hl : ("npm:" ++ name).toList = "npm:".toList ++ name.toList := String.toList_append
  have hb : BraceFree ("npm:" ++ name) := by
    intro c hc; rw [hl, List.mem_append] at hc
    rcases hc with hc | hc
    · simp at hc; rcases hc with rfl | rfl | rfl | rfl <;> simp [braceChars]
    · exact hbf c hc
  rw [parse_bf _ hb (by rw [hl]; simp)]
  unfold parseAlt
  rw [hl, prefixOf_append (by simp [prefixes])]
  have h1 : name.toList ≠ ['*'] := by
    intro e; apply hs; have := congrArg String.ofList e; simpa using this
  simp [parsePrefixed, h1, validPackage_of h]


theorem braceFree_prefix_append {p : String} (hp : p ∈ prefixes) {name : String}
    (hbf : BraceFree name) : BraceFree (p ++ name) := by
  intro c hc
  rw [String.toList_append, List.mem_append] at hc
  rcases hc with hc | hc
  · simp only [prefixes, List.mem_cons, List.not_mem_nil, or_false] at hp
    rcases hp with rfl | rfl | rfl | rfl | rfl | rfl <;> simp at hc <;>
      rcases hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
      simp [braceChars]
  · exact hbf c hc

theorem parse_prefixed_ok {p : String} (hp : p ∈ prefixes) (name : String) (hbf : BraceFree name)
    (hne : name ≠ "") : parse (p ++ name) = parsePrefixed p name.toList := by
  rw [parse_bf _ (braceFree_prefix_append hp hbf) (by rw [String.toList_append]; simp [string_ne_nil hne])]
  unfold parseAlt
  rw [String.toList_append, prefixOf_append hp]

/-- S5, `node:` and `bun:` names. -/
theorem parse_builtin (rt : Runtime) (name : String) (hbf : BraceFree name) (hne : name ≠ "")
    (hs : name ≠ "*") :
    parse ((match rt with | .node => "node:" | .bun => "bun:") ++ name) =
      .ok (.base (.builtin rt (some name))) := by
  have h1 : name.toList ≠ ['*'] := by
    intro e; apply hs; have := congrArg String.ofList e; simpa using this
  have h2 := string_ne_nil hne
  cases rt
  · rw [parse_prefixed_ok (by simp [prefixes]) name hbf hne]
    simp [parsePrefixed, builtinForm, h1, h2]
  · rw [parse_prefixed_ok (by simp [prefixes]) name hbf hne]
    simp [parsePrefixed, builtinForm, h1, h2]

/-- S5, `layer:` names. -/
theorem parse_layer (name : String) (hbf : BraceFree name) (hne : name ≠ "") :
    parse ("layer:" ++ name) = .ok (.layer name) := by
  rw [parse_prefixed_ok (by simp [prefixes]) name hbf hne]
  simp [parsePrefixed, string_ne_nil hne]

theorem parsePrefixed_error {p : String} {rest : List Char} {e : ParseError}
    (h : parsePrefixed p rest = .error e) : ∃ k n, e = .invalidName k n := by
  unfold parsePrefixed builtinForm at h
  repeat' split at h
  all_goals first | (simp at h; exact ⟨_, _, h.symm⟩) | simp at h


theorem dotStrip_ite (a : List Char) :
    (if a.take 2 = ['.', '/'] then a.drop 2 else a) = dotStrip a := by
  rcases a with _ | ⟨x, _ | ⟨y, r⟩⟩
  · rfl
  · simp [dotStrip]
  · by_cases hxy : x = '.' ∧ y = '/'
    · obtain ⟨rfl, rfl⟩ := hxy; simp [dotStrip]
    · rcases dotStrip_cases (x :: y :: r) with ⟨r', he, _⟩ | e
      · simp at he; exact absurd ⟨he.1, he.2.1⟩ hxy
      · rw [e]
        have : ¬ ((x :: y :: r).take 2 = ['.', '/']) := by
          intro h; simp at h; exact hxy h
        simp only [this, ite_false]

theorem plainSegments_eq (text : String) :
    plainSegments text = ((dotStrip text.toList).splitOn '/').map String.ofList := by
  unfold plainSegments
  show (List.splitOn '/' (if text.toList.take 2 = ['.', '/'] then text.toList.drop 2
    else text.toList)).map String.ofList = _
  rw [dotStrip_ite]

theorem ofList_inj {x y : List Char} : String.ofList x = String.ofList y ↔ x = y := by
  constructor
  · intro h; simpa using congrArg String.toList h
  · rintro rfl; rfl

theorem validSegments_iff (segs : List (List Char)) :
    ValidSegments (segs.map String.ofList) ↔ ∀ x ∈ segs, ¬ invalidSeg x = true := by
  unfold ValidSegments invalidSeg
  simp only [List.mem_map, forall_exists_index, and_imp, forall_apply_eq_imp_iff₂, decide_eq_true_eq]
  refine forall₂_congr fun x _ => ?_
  have h0 : ("" : String) = String.ofList [] := by decide
  have h1 : ("." : String) = String.ofList ['.'] := by decide
  have h2 : (".." : String) = String.ofList ['.', '.'] := by decide
  rw [h0, h1, h2, Ne, Ne, Ne, ofList_inj, ofList_inj, ofList_inj, not_or, not_or]

def PlainStr (s : String) : Prop := ∀ c ∈ s.toList, c ≠ '*' ∧ c ≠ '?'

theorem lit_accepts : ∀ (l ys : List Char),
    Pattern.accepts ((l.map SegmentToken.literal).map SegmentToken.denote) ys = true ↔ ys = l
  | [], ys => by cases ys <;> simp [Pattern.accepts]
  | c :: cs, ys => by
    cases ys with
    | nil => simp [SegmentToken.denote, Pattern.accepts]
    | cons y ys =>
      have ih := lit_accepts cs ys
      simp only [List.map_map] at ih
      simp [SegmentToken.denote, Pattern.accepts]
      intro _; exact ih

theorem segmentTokens_plain {s : String} (h : PlainStr s) :
    segmentTokens s = .segment (s.toList.map SegmentToken.literal) := by
  unfold segmentTokens
  congr 1
  apply List.map_congr_left
  intro c hc
  have := h c hc
  split <;> simp_all

theorem denote_plain {s : String} (h : PlainStr s) :
    (segmentTokens s).denote = .sat (fun q => decide (q = s)) := by
  rw [segmentTokens_plain h]
  show Pattern.Token.sat _ = _
  congr 1
  funext q
  apply Bool.eq_iff_iff.2
  unfold segmentAccepts
  rw [lit_accepts]
  simp [← String.toList_inj, eq_comm]

theorem accepts_plain : ∀ (strs : List String), (∀ s ∈ strs, PlainStr s) → ∀ p : List String,
    Pattern.accepts ((globTokens strs ++ [PathToken.globstar]).map PathToken.denote) p = true ↔
      strs.IsPrefix p
  | [], _, p => by
    simp [globTokens, PathToken.denote, Pattern.many_matches_all]
  | s :: ss, hs, p => by
    have ih := accepts_plain ss (fun x hx => hs x (List.mem_cons_of_mem _ hx))
    have hps : PlainStr s := hs s (List.mem_cons_self ..)
    have hn : s ≠ "**" := by
      rintro rfl; exact (hps '*' (by decide)).1 rfl
    have hg : globTokens (s :: ss) = segmentTokens s :: globTokens ss := by
      simp [globTokens, hn]
    rw [hg, List.cons_append, List.map_cons, denote_plain hps]
    cases p with
    | nil => simp [Pattern.accepts]
    | cons q p' =>
      simp only [Pattern.accepts, Bool.and_eq_true, decide_eq_true_eq, ih p', List.cons_prefix_cons]
      exact ⟨fun ⟨a, b⟩ => ⟨a.symm, b⟩, fun ⟨a, b⟩ => ⟨a.symm, b⟩⟩


theorem prefixOf_text_none {text : String} (hnp : ¬ Prefixed text) : prefixOf text.toList = none :=
  (prefixOf_none _).2 fun p hp h => hnp ⟨p, hp, h⟩

theorem bf_of_plain {text : String} (h : PlainPath text) : BraceFree text := by
  intro c hc hb
  apply h c hc
  simp only [braceChars, wildcardChars, List.mem_cons, List.not_mem_nil, or_false] at hb ⊢
  rcases hb with rfl | rfl | rfl <;> simp

theorem plainStr_segments {text : String} (hpl : PlainPath text) :
    ∀ s ∈ ((dotStrip text.toList).splitOn '/').map String.ofList, PlainStr s := by
  intro s hs c hc
  obtain ⟨x, hx, rfl⟩ := List.mem_map.1 hs
  rw [String.toList_ofList] at hc
  have := hpl c (mem_dotStrip ((mem_of_mem_splitOn _ x hx).2 c hc))
  simp only [wildcardChars, List.mem_cons, List.not_mem_nil, or_false, not_or] at this
  exact ⟨this.1, this.2.1⟩

/-- S2. -/
theorem spec_plain : ∀ text, ¬ Prefixed text → PlainPath text →
    (∀ c ∈ text.toList, c ∉ unsupportedChars) → ValidSegments (plainSegments text) →
    ∃ s, parse text = .ok s ∧
      ∀ p, selectsText s (.file p) = true ↔ (plainSegments text).IsPrefix p := by
  intro text hnp hpl hus hv
  rw [plainSegments_eq] at hv ⊢
  have hv' := (validSegments_iff _).1 hv
  have hne : text.toList ≠ [] := by
    intro e
    have := hv' [] (by simp [e, dotStrip])
    simp [invalidSeg] at this
  refine ⟨pathSel (dotStrip text.toList), ?_, ?_⟩
  · rw [parse_bf text (bf_of_plain hpl) hne]
    unfold parseAlt
    rw [prefixOf_text_none hnp]
    exact parsePath_eq _ hus hv'
  · intro p
    have hw : isWild (dotStrip text.toList) = false := by
      unfold isWild
      rw [Bool.eq_false_iff, Ne, List.any_eq_true]
      rintro ⟨c, hc, h⟩
      have := hpl c (mem_dotStrip hc)
      simp only [wildcardChars, List.mem_cons, List.not_mem_nil, or_false, not_or] at this
      simp [Bool.or_eq_true, beq_iff_eq] at h
      rcases h with rfl | rfl
      · exact this.1 rfl
      · exact this.2.1 rfl
    simp only [selectsText, pathSel, hw, ConfigSelector.selects, Selector.selects, pathAccepts]
    exact accepts_plain _ (plainStr_segments hpl) p


/-- S3. -/
theorem spec_glob : ∀ text, ¬ Prefixed text → ('*' ∈ text.toList ∨ '?' ∈ text.toList) →
    BraceFree text → (∀ c ∈ text.toList, c ∉ unsupportedChars) →
    ValidSegments (plainSegments text) →
    parse text = .ok (.base (.glob (globTokens (plainSegments text)))) := by
  intro text hnp hwild hbf hus hv
  rw [plainSegments_eq] at hv ⊢
  have hv' := (validSegments_iff _).1 hv
  have hne : text.toList ≠ [] := by
    rintro e; rw [e] at hwild; simp at hwild
  have hw : isWild (dotStrip text.toList) = true := by
    unfold isWild
    rw [List.any_eq_true]
    rcases hwild with h | h
    · exact ⟨'*', mem_dotStrip' (by decide) (by decide) h, by simp⟩
    · exact ⟨'?', mem_dotStrip' (by decide) (by decide) h, by simp⟩
  rw [parse_bf text hbf hne]
  unfold parseAlt
  rw [prefixOf_text_none hnp, show parsePath text.toList = _ from parsePath_eq _ hus hv']
  simp [pathSel, hw]

/-- S4. -/
theorem spec_braces : ∀ (pre a b post : String) (t : Target),
    BraceFree (pre ++ a ++ b ++ post) → ∀ sa sb,
    parse (pre ++ a ++ post) = .ok sa → parse (pre ++ b ++ post) = .ok sb →
    ∃ s, parse (pre ++ "{" ++ a ++ "," ++ b ++ "}" ++ post) = .ok s ∧
      (selectsText s t = (selectsText sa t || selectsText sb t)) := by
  intro pre a b post t hbf sa sb ha hb
  have hbf' : ∀ c, c ∈ pre.toList ∨ c ∈ a.toList ∨ c ∈ b.toList ∨ c ∈ post.toList →
      c ∉ braceChars := by
    intro c hc; apply hbf c
    simp only [String.toList_append, List.mem_append]
    rcases hc with h | h | h | h <;> simp [h]
  have hp : BFc pre.toList := fun c hc => hbf' c (Or.inl hc)
  have hqa : BFc a.toList := fun c hc => hbf' c (Or.inr (Or.inl hc))
  have hqb : BFc b.toList := fun c hc => hbf' c (Or.inr (Or.inr (Or.inl hc)))
  have hq : BFc post.toList := fun c hc => hbf' c (Or.inr (Or.inr (Or.inr hc)))
  have hmk : ∀ x : String, BFc x.toList → BFc (pre.toList ++ x.toList ++ post.toList) :=
    fun x hx => BFc_append.2 ⟨BFc_append.2 ⟨hp, hx⟩, hq⟩
  have ha' : parseChars (pre.toList ++ a.toList ++ post.toList) = .ok sa := by
    simpa [parse, String.toList_append] using ha
  have hb' : parseChars (pre.toList ++ b.toList ++ post.toList) = .ok sb := by
    simpa [parse, String.toList_append] using hb
  have hna := (parseChars_ok ha').1
  have hnb := (parseChars_ok hb').1
  rw [parseChars_bf _ (hmk a hqa) hna] at ha'
  rw [parseChars_bf _ (hmk b hqb) hnb] at hb'
  refine ⟨.any [sa, sb], ?_, ?_⟩
  · have hl : (pre ++ "{" ++ a ++ "," ++ b ++ "}" ++ post).toList =
        pre.toList ++ '{' :: joinComma a.toList [b.toList] ++ '}' :: post.toList := by
      simp [String.toList_append, joinComma]
    show parseChars (pre ++ "{" ++ a ++ "," ++ b ++ "}" ++ post).toList = _
    rw [hl]
    unfold parseChars
    have hnz : pre.toList ++ '{' :: joinComma a.toList [b.toList] ++ '}' :: post.toList ≠ [] := by
      simp
    simp only [hnz, ite_false]
    rw [expand_group pre.toList post.toList a.toList [b.toList] hp hq hqa (by simpa using hqb)]
    simp only [List.map_cons, List.map_nil]
    rw [forall2_parseAll _ _ (.cons ha' (.cons hb' .nil))]
    rfl
  · simp [selectsText, ConfigSelector.selects, ConfigSelector.selectsAny]

/-- S6, unsupported characters. -/
theorem spec_unsupported : ∀ text c, ¬ Prefixed text → BraceFree text → c ∈ text.toList →
    c ∈ unsupportedChars → ∃ c', parse text = .error (.unsupported c') := by
  intro text c hnp hbf hc hu
  have hne : text.toList ≠ [] := by rintro e; rw [e] at hc; simp at hc
  rw [parse_bf text hbf hne]
  unfold parseAlt
  rw [prefixOf_text_none hnp]
  exact parsePath_unsupported hc hu

/-- S6, invalid segments. -/
theorem spec_invalidSegment : ∀ text, ¬ Prefixed text → BraceFree text →
    (∀ c ∈ text.toList, c ∉ unsupportedChars) → ¬ ValidSegments (plainSegments text) →
    text ≠ "" → ∃ seg, parse text = .error (.invalidSegment seg) := by
  intro text hnp hbf hus hv hne
  rw [parse_bf text hbf (string_ne_nil hne)]
  unfold parseAlt
  rw [prefixOf_text_none hnp]
  rw [plainSegments_eq, validSegments_iff] at hv
  exact parsePath_invalid hus hv

/-- S6, invalid names. -/
theorem spec_invalidName : ∀ text, Prefixed text → BraceFree text → (∀ s, parse text ≠ .ok s) →
    ∃ k n, parse text = .error (.invalidName k n) := by
  intro text hpre hbf hall
  have hne : text.toList ≠ [] := by
    intro e
    obtain ⟨p, hp, t, ht⟩ := hpre
    rw [e] at ht
    have := (List.append_eq_nil_iff.1 ht).1
    simp only [prefixes, List.mem_cons, List.not_mem_nil, or_false] at hp
    rcases hp with rfl | rfl | rfl | rfl | rfl | rfl <;> simp at this
  cases h : prefixOf text.toList with
  | none =>
    obtain ⟨p, hp, hpp⟩ := hpre
    exact absurd hpp ((prefixOf_none _).1 h p hp)
  | some pr =>
    obtain ⟨p, rest⟩ := pr
    have hp : parse text = parsePrefixed p rest := by
      rw [parse_bf text hbf hne]; unfold parseAlt; rw [h]
    rw [hp]
    cases hres : parsePrefixed p rest with
    | ok s => exact absurd (hp.trans hres) (hall s)
    | error e =>
      obtain ⟨k, n, rfl⟩ := parsePrefixed_error hres
      exact ⟨k, n, rfl⟩

/-- S1–S6: `parse` and `print` satisfy the selector-text contract. -/
theorem text_spec : TextSpec parse print where
  roundTrip := parse_roundTrip
  plain := spec_plain
  glob := spec_glob
  braces := spec_braces
  packages := parse_npm_ok
  anyPackage := rfl
  builtins := parse_builtin
  anyBuiltin := fun rt => by cases rt <;> rfl
  layers := parse_layer
  unresolved := rfl
  computed := rfl
  empty := rfl
  unsupported := spec_unsupported
  invalidSegment := spec_invalidSegment
  invalidName := spec_invalidName

/-! ## Examples -/

private def globOf : Except ParseError ConfigSelector → Option (List PathToken)
  | .ok (.base (.glob ts)) => some ts
  | _ => none

private def errOf : Except ParseError ConfigSelector → Option ParseError
  | .error e => some e
  | _ => none

example : globOf (parse "src/domain") =
    some [.segment [.literal 's', .literal 'r', .literal 'c'],
      .segment [.literal 'd', .literal 'o', .literal 'm', .literal 'a', .literal 'i', .literal 'n'],
      .globstar] := by decide
example : globOf (parse "src/**/*.ts") =
    some [.segment [.literal 's', .literal 'r', .literal 'c'], .globstar,
      .segment [.star, .literal '.', .literal 't', .literal 's']] := by decide
example : errOf (parse "src//a") = some (.invalidSegment "") := by decide
example : errOf (parse "a\\b") = some (.unsupported '\\') := by decide
example : errOf (parse "npm:") = some (.invalidName "npm" "") := by decide
example : errOf (parse "{a") = some .unbalancedBraces := by decide
example : errOf (parse "a,b") = some .unbalancedBraces := by decide
example : errOf (parse "") = some .empty := by decide

private def render (s : String) : Option String := (parse s).toOption.bind print

example : render "src/domain" = some "src/domain/**" := by decide
example : render "src/**/*.ts" = some "src/**/*.ts" := by decide
example : render "{src/a,src/b}/**" = some "{src/a/**,src/b/**}" := by decide
example : render "npm:@scope/x" = some "npm:@scope/x" := by decide
example : render "npm:{react,zod}" = some "{npm:react,npm:zod}" := by decide
example : render "layer:app" = some "layer:app" := by decide
example : render "./npm:x" = some "./npm:x/**" := by decide
example : errOf (parse "npm:a,b") = some .unbalancedBraces := by decide
example : errOf (parse "npm:a/b") = some (.invalidName "npm" "a/b") := by decide

end Archer.Impl

#print axioms Archer.Impl.text_spec
