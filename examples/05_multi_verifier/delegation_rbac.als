// SPDX-License-Identifier: MIT
module delegation_rbac

sig Principal {
  approvalRank: one Int,
  delegatesTo: set Principal
}

sig EscrowRelease {
  requester: one Principal,
  approver: one Principal
}

fact DelegationFollowsRank {
  all p: Principal, q: p.delegatesTo | p.approvalRank < q.approvalRank
}

fact ModelHasRelease {
  some EscrowRelease
}

fact ApprovalRequiresDelegation {
  all release: EscrowRelease |
    release.approver in release.requester.delegatesTo
}

assert NoCyclicDelegation {
  no p: Principal | p in p.^delegatesTo
}

assert ApproverNotRequester {
  all release: EscrowRelease | release.approver != release.requester
}

check NoCyclicDelegation for 5
check ApproverNotRequester for 5
