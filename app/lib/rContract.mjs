// ── The ONE frozen R contract ────────────────────────────────────────────────────
// The single canonical BUILD-IT / grade contract, imported by EVERY producer so the stop a
// setup is BUILT on and the R it is GRADED in can never drift: a 1.2× H4 ATR-14 risk leg, a
// 1.5R target, a 168h (7d) time-stop. axisbt (the harness grade), the Catalyst card (the client
// draft), and nexus-lab-api logic (the server catalyst thesis) all import THIS object — change a
// value here and all three move in lockstep, which is the point. The ruler itself (H4 ATR-14)
// lives in atr.mjs; these are the frozen multiples applied on top of it. Object.freeze so a
// consumer can spread an override (gradeEventR) without ever mutating the shared source.
export const R_CONTRACT = Object.freeze({ atrMult: 1.2, rMultiple: 1.5, maxHoldH: 168 });
