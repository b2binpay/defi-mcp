# @b2binpay/defi-mcp

Local [MCP](https://modelcontextprotocol.io) server for the [B2BINPAY DeFi](https://defi.b2binpay.com) platform.

It runs on your machine over the **stdio** transport, holds the agent signing key in a
**local keystore**, and drives a full multisig payout end-to-end against the backend:
authenticate, select account, propose payout, sign, execute on-chain once the signature
threshold is met.

## Trust boundary

This server owns the boundary the backend must never cross:

- The signing key lives **only here**, in a local keystore. It never leaves the machine
  and never enters LLM context.
- The backend prepares operations (EIP-712 typed data) and never holds keys.
- This server signs; it never queries the database.

## Architecture

```
LLM agent ──stdio──▶ defi-mcp (this server) ──HTTP──▶ backend
                       │                                ├─ POST /auth/*   (SIWE → JWT)
                       ├─ local keystore (agent key)    └─ POST /mcp      (JSON-RPC 2.0)
                       └─ @b2binpay/defi-sdk (EIP-712 typed data, execute-tx building)
```

- **Backend transport** — JSON-RPC 2.0 over `POST /mcp`, authenticated with a JWT obtained
  from the SIWE flow (`/auth/nonce` → `/auth/verify`). The local orchestration consumes
  `get_account`, `get_queue_operation` and `submit_signature`; every other backend tool is
  proxied through untouched.
- **Signing / execute** — [`@b2binpay/defi-sdk`](https://github.com/b2binpay/defi-sdk-nodejs) builds the EIP-712 Execute typed
  data and the on-chain execute transaction; this server signs and broadcasts.

## Agent-facing tools

### Local tools

These seven run locally. `sign_operation`, `execute_operation`, `deploy_account` and `claim` are the only tools that sign with the keystore key or broadcast on-chain; `review_operation` is read-only:

- `select_account` — pick the multisig account to act on by `accountId` (+ optional
  `chainId`, defaults to `DEFAULT_CHAIN_ID`); resolves the deployment via
  `get_account` and the RPC from the network map, holding
  `{ deploymentId, contract, chainId, rpcUrl, version }`
- `deploy_account` — deploy the multisig on-chain (`createInstance` on the proxy factory)
  on a target `chainId` (+ optional, defaults to `DEFAULT_CHAIN_ID`); the backend indexer
  registers the deployment afterward
- `review_operation` — read-only: decode what signing a queued operation authorizes from its calls alone
  (native and ERC-20 transfers, allowances incl. `increaseAllowance` / `setApprovalForAll` / Permit2 `approve`,
  owner and whitelist changes, claims, TRON staking), with warnings and the exact `confirm` text to sign with.
  Token amounts are raw base units next to the token address (decimals from the backend are not trusted).
  Warnings — owners that differ from the payload, removal of this agent's signer, allowance grants, claims or
  pulls to another address — come before the effects in `confirm`. Proposer-written fields (`dappName`,
  `payload`, `decodedOperations`) are returned as `unverifiedProposerFields` and never describe the effect
- `sign_operation` — sign a queued operation with the keystore key and submit the signature. It requires
  `confirm` = the review's `confirm`, re-derives it from the calls it is about to sign and signs nothing on a
  mismatch, so the host's tool-approval prompt always shows the real recipients, amounts and owners. A call whose
  effect cannot be decoded also needs `allowUnknownCalls: true`: a CoW pre-signature (the order terms are not in
  the call), LayerZero cross-chain bridge steps, and any dApp call with an unknown selector.
  **Never configure the host to auto-approve `sign_operation`** — its approval prompt is where the human sees
  what is being signed
- `execute_operation` — broadcast the on-chain execute tx once the threshold is met
- `claim` — sweep all claimable invoice deposits of a `currencyId` into the selected multisig
  (direct on-chain `claim` call; no signatures/queue, since funds move into the account)
- `get_signer_addresses` — the local signer address per configured protocol (`{ evm, tvm }`)

### Proxied backend tools

Everything else the agent sees comes from the backend's `POST /mcp` and is proxied
unchanged. The groups:

| Group | What it covers |
|---|---|
| Reference data | chains, currencies, exchange rates, contract versions, service status, the caller's profile |
| Accounts | account list/create/read, deploy params, dashboard, fiat-aggregated and per-chain balances |
| Queue | the multisig queue, one operation, batch candidates, nonce state, signature submission |
| Invoices and claims | invoices, invoice operations, claimable assets, batch-claim aggregates |
| Payouts | payout proposal plus the payout reads |
| Operations history | the generic operation and transaction reads for every operation type |
| Staking (TRON) | staking/voting/delegation views, SR list, network params, and the eight staking proposals |
| Cross-chain | route discovery, source currencies, quoting, and the transfer proposal |
| Credits | pricing catalog, account balance, top-up history |
| Settings and compliance | address book, callbacks and callback settings, Auto Claim views, AML checks and settings, team messages |
| Governance proposals | multisig config, claim whitelist, reject, claim-to, CowSwap pre-signature, arbitrary dApp call |

**`tools/list` and `initialize` are the authority, not this table.** The backend returns its own
`instructions` from `initialize` describing its domain and naming its tools, and this server merges
that text ahead of its own before handing it to the agent — so per-tool semantics live in the
backend and cannot go stale here. A backend release can add a tool without a change in this repo;
run `tools/list` to see what a given backend actually exposes. The listing spans several pages at
this size and the client follows `nextCursor` to exhaustion.

## Networks (multi-chain)

The server is not bound to one chain. It holds a network registry (`chainId → RPC`) and
the agent picks the network per operation via `select_account`/`deploy_account` `chainId`.
One agent key (EOA) works across all EVM chains, so you can drive several networks —
two testnets, two mainnets, any mix — from one running server by switching accounts.

- A wide set of EVM networks is built in (`DEFAULT_NETWORKS` in `src/config/env.ts`:
  Ethereum, Sepolia, BSC (+ testnet), Polygon (+ Amoy), Arbitrum (+ Sepolia), Base
  (+ Sepolia), Optimism (+ Sepolia)) with public RPCs.
- Override or add any chain with an env var: `RPC_URL_<chainId>=<url>`
  (e.g. `RPC_URL_11155111=https://my-sepolia`, `RPC_URL_97=https://my-bsc-testnet`).
- `DEFAULT_CHAIN_ID` (default `11155111`) is used when `chainId` is omitted.

```
select_account { accountId, chainId: 11155111 }   # act on Sepolia
select_account { accountId, chainId: 97 }          # switch to BSC testnet
```

### TRON (TVM)

TRON networks are also built in — Mainnet `728126428` (`https://api.trongrid.io`), Shasta
`2494104990` (`https://api.shasta.trongrid.io`) and Nile `3448148188` (`https://nile.trongrid.io`) —
overridable via `RPC_URL_<chainId>` (fullHost). The production platform serves TRON **mainnet**;
the Shasta and Nile entries are for test environments that enable them.

TRON uses a **different identity** than EVM (base58 `T…` vs `0x…`). The server holds up to two
signing identities — one EVM, one TVM — and acts on **both** in one process; the protocol of an
operation is derived from the target chain. Each identity is a distinct backend principal with
its own account view, so when the target protocol is unclear from the request the agent asks
which network you mean. `select_account` / `propose_*` / `sign_operation` / `execute_operation` /
`deploy_account` all work on TRON (TIP-712 sign + TronWeb broadcast); `TRON_FEE_LIMIT` (SUN,
default 150000000) caps the execute/deploy fee.

## Signing keys

Configure at least one slot; keys never leave the process or enter LLM context (keep the env
file `chmod 600` and gitignored). Per slot the source resolves in priority order: per-slot
private key → per-slot mnemonic → shared `MNEMONIC`.

- `MNEMONIC` — one BIP39 mnemonic for both slots (EVM at `m/44'/60'/0'/0/0`, TVM at
  `m/44'/195'/0'/0/0`; addresses match MetaMask / TronLink on import).
- `EVM_MNEMONIC` / `TVM_MNEMONIC` — a different mnemonic per protocol.
- `EVM_PRIVATE_KEY` / `TVM_PRIVATE_KEY` — a raw hex key per protocol.

Setting both a private key and a mnemonic on one slot is an error. `get_signer_addresses`
returns the derived address per configured slot. Mnemonic generation is future scope.

### OS-keychain storage (`KEY_SOURCE=keychain`)

To keep keys out of plaintext config, store them in the OS secret store (macOS Keychain /
Windows Credential Manager / Linux Secret Service) instead of env vars. Opt-in and off by
default — `KEY_SOURCE=env` (or unset) keeps the behavior above unchanged, and env-only users
never load the native keychain module.

Setup:

```bash
defi-mcp keychain set evm     # prompts for the secret (input hidden); or pipe it via stdin
defi-mcp keychain set tvm     # a hex private key or a BIP39 mnemonic — auto-detected
defi-mcp keychain list        # -> "evm: set", "tvm: absent" (presence only, never the value)
defi-mcp keychain rm evm      # idempotent
```

Then set `KEY_SOURCE=keychain` and **remove the key env vars** (`MNEMONIC` / `*_PRIVATE_KEY` /
`*_MNEMONIC`) from the MCP client config. Notes:

- The secret is read only from a no-echo prompt or piped stdin — never from a command-line
  argument (which would land in shell history / process listings) and never logged. Pass **only**
  the slot on the command line (`set evm`); the value follows on the prompt/stdin. For automation
  prefer a file/heredoc/secret-manager over a literal `echo secret | …`.
- A stored value is either a 64-char hex private key or a BIP39 mnemonic. A piped mnemonic may span
  lines — internal whitespace is normalized to single spaces before storing. A hex-looking value of
  the wrong length is rejected as a mistyped key (not retried as a mnemonic).
- Each slot is one entry under service `b2binpay-defi-mcp`, accounts `evm` / `tvm`, resolved
  independently. A shared `MNEMONIC` becomes **two entries** — run `set evm` and `set tvm`.
- Requires the optional `@napi-rs/keyring` native module (prebuilt for common platforms). If it
  can't load, `KEY_SOURCE=keychain` fails at startup naming the fix — install it or use `env`.
- No fallback to env: the keychain backend never reads env keys — switching to plaintext is an
  explicit `KEY_SOURCE=env`. A slot with no entry is simply empty. On a headless host with no
  Secret Service the store is unreachable and startup fails fatally. Note: with the current
  `@napi-rs/keyring`, a *locked or access-denied* keychain read on macOS/Windows surfaces as an
  empty slot (so the server fails with "No signing key configured") rather than a distinct locked
  error — unlock the keychain / grant access and retry. Rollback is `KEY_SOURCE=env` (or unset)
  plus the key env var — entries can stay.
- **macOS**: the Keychain may show a per-read allow/unlock prompt on server start and on
  `keychain list` (which reads to check presence); this is expected. `keychain` management runs
  before any config/key loading, so it works even with no key configured.

Platform support (`@napi-rs/keyring` prebuilt binaries + runtime backend):

| Platform | Backend | Notes |
|---|---|---|
| macOS (arm64 / x64) | Keychain | prebuilt; smoke-tested. May prompt per read (ACL). |
| Windows (arm64 / x64) | Credential Manager | prebuilt; unit-tested against a mock, not smoke-tested. |
| Linux (gnu / musl, arm64 / x64) | Secret Service (libsecret) | prebuilt; needs a running Secret Service — headless hosts have none (fatal, use `KEY_SOURCE=env`). |

## Backend routing across identities

Each slot is a **separate backend principal** with its own JWT and its own account view, so a
proxied backend call must run under the identity that owns the target account. The gateway routes
each call as follows:

- **A session is selected** (`select_account`) → the session's protocol pins the client.
- **`create_account`** → routed by the request's own `isTron` flag, *before* the session check —
  it creates a new account of that family, so an active EVM session must not force a TRON creation
  onto the EVM identity. A missing target slot errors instead of misrouting.
The scope comes from the backend: every `tools/list` entry carries `annotations.scope`, read once at
boot, so the classification lives with the tools and this server keeps no list of tool names.

- **`identity`** reads (`list_accounts`, `get_profile`) take no account argument and can only be
  answered per principal → fanned out to every filled slot and returned tagged per protocol,
  `[{ protocol, result }]`, using `allSettled` so a degraded slot comes back with an `error` field
  instead of failing the healthy one.
- **`catalog`** reads answer the same for every principal (currencies, networks, rates, service
  status, contract versions, credit pricing, bridge routes) → a single slot, never fanned out. An
  explicit `deploymentId` overrides the scope: it narrows the answer to one account, so only the
  owning identity may serve it.
- **`account`** is everything else, and also the default for any tool the catalog does not
  classify — a backend that publishes no annotations, or a tool added after this server booted.
  With both slots filled and no session it requires an account to be selected first; fanning it
  out would 403 on the non-owner identity. The only names still hardcoded are `list_accounts` and
  `get_profile`, as the fallback that keeps discovery working against such a backend.

Auth is a **lazy per-protocol registry**: a slot authenticates on first use; boot authenticates
one slot only, to fetch the identity-independent tool catalog. The chain a slot authenticates the
nonce under is derived (the default chain if its kind matches, else the first configured chain of
the kind). When that derived chain is a mainnet the backend env doesn't enable (e.g. a Shasta-only
dev picking TRON mainnet), set an explicit `EVM_AUTH_CHAIN_ID` / `TVM_AUTH_CHAIN_ID` — it must be a
chain of that slot's kind, or startup rejects it.

## End-to-end demo

`scripts/e2e-full.ts` and `scripts/e2e-full.tron.ts` spawn the built server over stdio and drive
the whole flow as an agent would: deploy the agent's first account if it is not on-chain yet, fund
it from the agent key, propose a payout back to the agent, review, sign and execute. They need a
backend that enables the chain and a funded agent key on it:

```bash
pnpm build
# fill .env with a signing slot (EVM_PRIVATE_KEY / TVM_PRIVATE_KEY / MNEMONIC) and DEFAULT_CHAIN_ID
pnpm e2e:evm    # EVM, on DEFAULT_CHAIN_ID
pnpm e2e:tron   # TRON, on TVM_CHAIN_ID (default Shasta 2494104990)
```

## Development

```bash
pnpm install
cp .env.example .env   # fill in backend URLs, chain, RPC, a signing slot (MNEMONIC / *_PRIVATE_KEY)
pnpm dev               # stdio server with watch
pnpm build             # tsc → dist/
pnpm typecheck
pnpm lint
pnpm test
```

Requires Node.js `>=24.16.0` and pnpm `^12` — the repo pins
`packageManager: pnpm@12.5.1`, so `corepack enable` is enough to get the right version. Install
settings that are not plain registry config (supply-chain release cooldown, build-script
allowlist) live in [`pnpm-workspace.yaml`](pnpm-workspace.yaml).

### `@b2binpay/defi-sdk` dependency

The SDK is consumed from npm as a versioned range (`"@b2binpay/defi-sdk": "^2.0.0"`) and lives in
[`defi-sdk-nodejs`](https://github.com/b2binpay/defi-sdk-nodejs). To try an unreleased SDK change,
point the dependency at a local checkout (`"file:../defi-sdk-nodejs"`) and build it there; imports
do not change because the package name is the same.

## Install & run as an MCP server

Requirements: Node.js `>=24.16.0`.

**1. Install.**

```bash
npm install -g @b2binpay/defi-mcp        # exposes the `defi-mcp` command
```

**2. Configure.** The server targets the production platform out of the box, so a signing slot is
the only required setting (full reference in [`.env.example`](.env.example)). The signing key is the
backend principal — its address must own accounts on the platform.

| Variable            | Default                               | Notes                                                                                        |
|---------------------|---------------------------------------|----------------------------------------------------------------------------------------------|
| `MNEMONIC`          | —                                     | derives EVM (`m/44'/60'`) + TVM (`m/44'/195'`); or use `EVM_PRIVATE_KEY` / `TVM_PRIVATE_KEY` |
| `BACKEND_API_URL`   | `https://api.defi.b2binpay.com`       | bare host, no `/api/v1`                                                                      |
| `BACKEND_MCP_URL`   | `https://mcp.defi.b2binpay.com/mcp`   | JSON-RPC `/mcp` endpoint                                                                     |
| `AUTH_URL`          | `https://defi.b2binpay.com`           | SIWE domain the backend accepts for sign-in                                                  |
| `DEFAULT_CHAIN_ID`  | `11155111` (Sepolia)                  | chain used when `select_account` / `deploy_account` omit `chainId`                           |
| `TVM_AUTH_CHAIN_ID` | —                                     | chain the TVM slot signs in under; defaults to TRON mainnet `728126428` when `DEFAULT_CHAIN_ID` is EVM |
| `RPC_URL_<chainId>` | public RPCs (see [Networks](#networks-multi-chain)) | one per chain you want to override                                             |

The backend tool catalog follows the platform release, so check `tools/list` rather than assuming a
fixed set. Keep the key file `chmod 600`. To avoid a plaintext key in the client config entirely,
store it in the OS keychain and set `KEY_SOURCE=keychain` instead — see
[OS-keychain storage](#os-keychain-storage-key_sourcekeychain).

**3. Wire into an MCP client.** The server speaks stdio. MCP clients (Claude Desktop especially)
launch with a minimal `PATH` that does not include a Node version manager's bin dir (nvm / fnm /
volta), so the `defi-mcp` shim — and often `node` itself — is not resolvable. The reliable config
therefore uses **absolute paths** to `node` and the installed entry file. Claude Desktop / any
`mcpServers` config:

```json
{
  "mcpServers": {
    "defi-mcp": {
      "command": "/Users/you/.nvm/versions/node/v24.16.0/bin/node",
      "args": ["/Users/you/.nvm/versions/node/v24.16.0/lib/node_modules/@b2binpay/defi-mcp/dist/src/index.js"],
      "env": {
        "MNEMONIC": "your seed phrase",
        "DEFAULT_CHAIN_ID": "11155111"
      }
    }
  }
}
```

Find the two absolute paths with:

```bash
command -v node                                              # → "command"
echo "$(npm root -g)/@b2binpay/defi-mcp/dist/src/index.js"   # → "args"
```

Claude Code (pass the same absolute paths):

```bash
claude mcp add defi-mcp --scope user \
  --env MNEMONIC="your seed phrase" \
  --env DEFAULT_CHAIN_ID=11155111 \
  -- "$(command -v node)" "$(npm root -g)/@b2binpay/defi-mcp/dist/src/index.js"
```

For TRON, configure a TVM slot (`TVM_PRIVATE_KEY`, or the shared `MNEMONIC`) and set
`DEFAULT_CHAIN_ID=728126428` (TRON mainnet).

> **Shorter forms** — only if your MCP client inherits your shell `PATH` (some do; Claude Desktop
> generally does not): `"command": "defi-mcp"`, or skip the global install with
> `"command": "npx", "args": ["-y", "@b2binpay/defi-mcp"]`. `npx` does **not** avoid the PATH
> problem (npx must also be on `PATH`) and re-resolves the package on every launch, so for a
> frequently-spawned stdio server the absolute-path form above is preferred.

**4. Verify.** On start the server logs to stderr:
`b2binpay-defi-mcp vX ready on stdio (TVM T… , 7 local + N backend tools)`. The client then exposes
the seven local tools (`select_account`, `deploy_account`, `review_operation`, `sign_operation`,
`execute_operation`, `claim`, `get_signer_addresses`) plus the proxied backend surface — `tools/list` enumerates it.

## Contributing

Bug reports and pull requests are welcome at
[github.com/b2binpay/defi-mcp](https://github.com/b2binpay/defi-mcp/issues).

## License

MIT — see [LICENSE](LICENSE).
