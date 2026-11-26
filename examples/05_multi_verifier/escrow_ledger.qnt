// SPDX-License-Identifier: MIT
module escrow_ledger {
  var balance: int
  var refunded: int

  pure val escrow = 2

  action init = all {
    balance' = escrow,
    refunded' = 0,
  }

  action refund = all {
    balance > 0,
    balance' = balance - 1,
    refunded' = refunded + 1,
  }

  action wait = all {
    balance' = balance,
    refunded' = refunded,
  }

  action step = any { refund, wait }

  val refundsWithinEscrow = refunded <= escrow
  val nonNegativeEscrowBalance = balance >= 0
}
