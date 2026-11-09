# TASK 66 — Sender Wallet Verification (Read-Only)

## VERDICT: PASS

## File metadata (public only)
- Path: /home/ubuntu/.agenttrust/sender.export
- Regular file: yes
- Mode: 0600 (owner read/write only)
- UID: 1001 (ubuntu)
- Size: 496 bytes
- Directory: /home/ubuntu/.agenttrust (mode 0700)
- Original Downloads file: moved (no longer present)

## Derived sender (SDK parseWallet, no signing)
- Derived address: 4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d
- Matches approved sender: yes
- Account threshold: 1
- Credential count: 1 (index 0)
- Credential threshold: 1
- Credential key count: 1
- Credential scheme: Ed25519
- Credential public keys: match on-chain (not printed)

## Live Testnet account match
- Account exists: yes
- Account threshold: 1 (match)
- Credential count: 1 (match)
- Credential indices: 0 (match)
- Credential thresholds: 1 (match)
- Credential key counts: 1 (match)
- Credential schemes: Ed25519 (match)
- Public keys: match
- Nonce: 1
- Balance: 19943.619923 CCD (read-only)

## Sponsor / sender separation
- Sender: 4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d
- Sponsor: 3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK
- Distinct: yes

## Testnet identity
- Genesis: 4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796 (match)
- CAIP-2: ccd:4221332d34e1694168c2a0c0b3fd0f27 (match)

## Security
- No wallet contents, private keys, or secret fingerprints printed or transmitted.
- No sign() call. No signing IPC service contacted.
- No transaction constructed or submitted.
- Sponsor wallet (/home/ubuntu/.agenttrust/sponsor.export) untouched.

## Conclusion
The sender wallet export controls the approved sender account on Testnet. TASK65 Phase 3
can be reconsidered using the previously approved transaction parameters (sponsor
3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK, recipient
4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d, amount 1 microCCD, max fee 10 CCD).

This task does not authorize signing or broadcasting. Any subsequent execution requires
separate explicit approval.

