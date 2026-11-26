module refund_guard {
  var paid: int
  var refunded: int

  action init = all {
    paid' = 2,
    refunded' = 0,
  }

  action step = any {
    all {
      refunded < paid,
      refunded' = refunded + 1,
      paid' = paid,
    },
    all {
      refunded' = refunded,
      paid' = paid,
    },
  }

  val refundsWithinPaid = refunded <= paid
  val balanceNonNegative = paid - refunded >= 0
}
