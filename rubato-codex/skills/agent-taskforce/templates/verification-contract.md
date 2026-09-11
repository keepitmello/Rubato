# Verification contract

Optionally agreed between owner and verifier before implementation when acceptance is ambiguous, the blast radius is large, or human interpretation of rendered artifacts could shift the criterion mid-run. Use it only when writing the criterion down will prevent real rework; do not create it for clear, small tasks.

**Outcome:** the environment state this workstream must produce.

**Criterion version:** bump when the acceptance criterion changes; labels produced under an old version become stale, not silently trusted.

**Checks:**
- 
- 

**Failure conditions:** the concrete states that mean the result is a failure. Distinguish `target-failure` from `measurement-invalid` (the measurement path itself broke: resource contention, exhausted quota, plausible empty output).

**Measurement controls:** what keeps this gate honest when the measurement path itself can break — which known-good targets ride in the batch, and where raw evidence is preserved.

**Instrument validation:** fill this only when measurement is itself the deliverable — which labeled sample validates the judge, and what result clears it for the full sweep. `teammate/independent-verifier.md` carries the rules; write here what they mean for *this* outcome.

**Evidence method:** tests, browser paths, runtime observation, source sets, artifact inspection, etc.

**Out of scope:** what this gate does not judge.

**Owner proposal:**

**Verifier challenge / accepted revision:**

**Final agreement:** AGREED | NEEDS_DECISION
