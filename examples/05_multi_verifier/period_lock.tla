\* SPDX-License-Identifier: MIT
------------------------------ MODULE period_lock ------------------------------
EXTENDS Naturals

CONSTANTS Limit, AllowOverBudget
VARIABLES spent, closed, lockedSpent

vars == <<spent, closed, lockedSpent>>

Init == /\ spent = 0
        /\ closed = FALSE
        /\ lockedSpent = 0

PostRelease ==
  /\ ~closed
  /\ spent < Limit + 1
  /\ AllowOverBudget \/ spent < Limit
  /\ spent' = spent + 1
  /\ UNCHANGED <<closed, lockedSpent>>

ClosePeriod ==
  /\ ~closed
  /\ closed' = TRUE
  /\ lockedSpent' = spent
  /\ UNCHANGED spent

Wait == UNCHANGED vars

Next == PostRelease \/ ClosePeriod \/ Wait

ClosedPeriodImmutable == closed => spent = lockedSpent
DraftBudgetLimit == ~closed => spent <= Limit
================================================================================
