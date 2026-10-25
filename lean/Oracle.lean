import Archer.Oracle.Json
import Archer
import Lean.Data.Json

open Lean (Json)
open Archer Archer.Oracle

structure CustomResult where
  name : String
  subject : FilePath
  messages : List String

def decCustomResult : Dec CustomResult := fun j => do
  pure ⟨← getField j "name" decStr, ← getField j "subject" (decList decStr),
    ← getField j "messages" (decList decStr)⟩

def customRules (rs : List CustomResult) : CustomRules := fun name _ subject =>
  match rs.find? fun r => r.name == name && r.subject == subject with
  | some r => r.messages
  | none => []

def encParseError : ParseError → Json
  | .empty => tagged "Empty" []
  | .invalidName kind name => tagged "InvalidName" [("kind", encStr kind), ("name", encStr name)]
  | .invalidSegment text => tagged "InvalidSegment" [("text", encStr text)]
  | .unsupported c => tagged "Unsupported" [("char", encChar c)]
  | .unbalancedBraces => tagged "UnbalancedBraces" []

def answer (req : Json) : Except String Json := do
  match ← getField req "op" decStr with
  | "pathAccepts" =>
      pure (encBool (pathAccepts (← getField req "tokens" (decList decPathToken))
        (← getField req "path" (decList decStr))))
  | "selects" =>
      let s ← getField req "selector" (decSelector fuel)
      pure (encBool (s.selects (← getField req "target" decTarget)))
  | "reach" =>
      let g ← getField req "graph" decGraph
      let ef ← getField req "edges" decEdgeFilter
      let src ← getField req "source" (decList decStr)
      pure (encList (encPair encTarget (encList encEdge)) (Impl.reach g ef src))
  | "check" =>
      let p ← getField req "policy" (decList decRule)
      let g ← getField req "graph" decGraph
      let cs ← getField req "custom" (decList decCustomResult)
      pure (encList encViolation (Impl.check (customRules cs) p g))
  | "lower" =>
      match Impl.lower (← getField req "config" decConfig) with
      | .ok p => pure (Json.mkObj [("ok", encList encRule p)])
      | .error e => pure (Json.mkObj [("error", encConfigError e)])
  | "encode" => pure (encStr (Impl.encode (← getField req "fingerprint" decFingerprint)))
  | "decode" =>
      match Impl.decode (← getField req "line" decStr) with
      | some f => pure (encFingerprint f)
      | none => pure Json.null
  | "record" =>
      pure (encList encFingerprint (Impl.record (← getField req "violations" (decList decViolation))))
  | "apply" =>
      let b ← getField req "baseline" (decList decFingerprint)
      let vs ← getField req "violations" (decList decViolation)
      pure (encApplied (Impl.apply b vs))
  | "fingerprint" => pure (encFingerprint (← getField req "violation" decViolation).fingerprint)
  | "parse" =>
      match Impl.parse (← getField req "text" decStr) with
      | .ok s => pure (Json.mkObj [("ok", encConfigSelector s)])
      | .error e => pure (Json.mkObj [("error", encParseError e)])
  | "print" =>
      match Impl.print (← getField req "selector" (decConfigSelector fuel)) with
      | some text => pure (encStr text)
      | none => pure Json.null
  | "emptyObjects" =>
      let p ← getField req "policy" (decList decRule)
      let g ← getField req "graph" decGraph
      pure (encList encStr (emptyObjects p g))
  | "emptySubjects" =>
      let p ← getField req "policy" (decList decRule)
      let g ← getField req "graph" decGraph
      pure (encList encStr (emptySubjects p g))
  | op => throw s!"unknown op {op}"

def readAll (h : IO.FS.Stream) : IO String := do
  let mut acc := ""
  repeat
    let line ← h.getLine
    if line.isEmpty then break
    acc := acc ++ line
  pure acc

def main : IO UInt32 := do
  let input ← readAll (← IO.getStdin)
  match Json.parse input >>= Json.getArr? with
  | .error e =>
      (← IO.getStderr).putStrLn s!"archer-oracle: input is not a JSON array: {e}"
      pure 1
  | .ok reqs =>
      let out := reqs.map fun r =>
        match answer r with
        | .ok j => j
        | .error e => Json.mkObj [("invalid", Json.str e)]
      IO.println (Json.arr out).compress
      pure 0
