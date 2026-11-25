import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { LocalAccount } from 'viem';
import { z } from 'zod';
import type { BackendRegistry } from '../backend/backend-registry.js';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import {
  type AccountDeployment,
  type AccountDetails,
  accountDetailsSchema,
  type TvmAccountDetails,
  tvmAccountDetailsSchema,
} from '../backend/tool-results.js';
import { type ChainKind, chainKind } from '../config/chain-kind.js';
import { type AppConfig, rpcForChain } from '../config/env.js';
import type { Keystore, TronSigner } from '../keystore/keystore.js';
import { claim } from '../orchestration/claim.js';
import { claimTron } from '../orchestration/claim.tron.js';
import { deployAccount } from '../orchestration/deploy-account.js';
import { deployAccountTron } from '../orchestration/deploy-account.tron.js';
import { executeOperation } from '../orchestration/execute-operation.js';
import { executeOperationTron } from '../orchestration/execute-operation.tron.js';
import { reviewOperation } from '../orchestration/review-operation.js';
import { type AccountSession, parseContractVersion, type SessionStore } from '../orchestration/session.js';
import { signOperation } from '../orchestration/sign-operation.js';
import { signOperationTron } from '../orchestration/sign-operation.tron.js';
import { toTronBase58 } from '../orchestration/tron-address.js';

export interface ToolContext {
  keystore: Keystore;
  registry: BackendRegistry;
  sessions: SessionStore;
  config: AppConfig;
}

export interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

/** Deployment status (lowercased) that marks an account as live on a chain. */
const DEPLOYMENT_STATUS_DEPLOYED = 'deployed';

/** Find the account's deployment on `chainId` and assert it is deployed. */
function requireDeployedDeployment(
  deployments: AccountDeployment[],
  accountId: string,
  chainId: number,
): AccountDeployment {
  const deployment = deployments.find((candidate) => candidate.chainId === String(chainId));
  if (!deployment) {
    throw new Error(`Account ${accountId} has no deployment on chain ${chainId}`);
  }
  if (deployment.deploymentStatus.toLowerCase() !== DEPLOYMENT_STATUS_DEPLOYED) {
    throw new Error(
      `Account ${accountId} deployment on chain ${chainId} is not deployed (status: ${deployment.deploymentStatus})`,
    );
  }
  return deployment;
}

/**
 * Fetch the account and assert its family matches the target chain kind, so a TRON account is
 * never acted on as EVM (or vice versa). The kind narrows the returned details type.
 */
function fetchAndAssertAccount(
  client: BackendMcpClient,
  kind: 'tvm',
  accountId: string,
  chainId: number,
): Promise<TvmAccountDetails>;
function fetchAndAssertAccount(
  client: BackendMcpClient,
  kind: 'evm',
  accountId: string,
  chainId: number,
): Promise<AccountDetails>;
async function fetchAndAssertAccount(
  client: BackendMcpClient,
  kind: ChainKind,
  accountId: string,
  chainId: number,
): Promise<TvmAccountDetails | AccountDetails> {
  if (kind === 'tvm') {
    const details = tvmAccountDetailsSchema.parse(await client.callTool('get_account', { accountId }));
    if (!details.account.isTron) {
      throw new Error(`Account ${accountId} is not a TRON account but chain ${chainId} is a TVM chain`);
    }
    return details;
  }
  const details = accountDetailsSchema.parse(await client.callTool('get_account', { accountId }));
  if (details.account.isTron) {
    throw new Error(`Account ${accountId} is a TRON account but chain ${chainId} is an EVM chain`);
  }
  return details;
}

/** Shared args for the account-on-a-chain tools (select_account, deploy_account). */
const accountChainArgsSchema = z.object({
  accountId: z.string().min(1),
  chainId: z.coerce.number().int().positive().optional(),
});

/** Queue operation ids are snowflake integers. */
const operationArgsSchema = z.object({ operationId: z.string().regex(/^\d+$/, 'expected a numeric operation id') });

/** `confirm` stays optional here so a call without it gets the review back instead of a bare validation error. */
const signArgsSchema = operationArgsSchema.extend({
  confirm: z.string().optional(),
  allowUnknownCalls: z.boolean().optional(),
});

const claimArgsSchema = z.object({ currencyId: z.string().min(1) });

type EvmSession = Extract<AccountSession, { chainKind: 'evm' }>;
type TvmSession = Extract<AccountSession, { chainKind: 'tvm' }>;

export function buildLocalTools(context: ToolContext): LocalTool[] {
  const { keystore, registry, sessions, config } = context;

  /**
   * Resolve the chain to act on: an explicit `chainId` wins; otherwise the configured default
   * applies only when its kind has a filled slot, so a default for an unconfigured protocol
   * never silently misroutes.
   */
  const resolveChainId = (explicit: number | undefined): number => {
    if (explicit !== undefined) {
      return explicit;
    }
    if (keystore.identity(chainKind(config.defaultChainId))) {
      return config.defaultChainId;
    }
    throw new Error('No chainId given and the default chain has no configured key slot; pass an explicit chainId');
  };

  /**
   * Dispatch a session-scoped operation by the selected chain kind, resolving the backend client
   * and the protocol's signer/account once. Collapses the `if (tvm) {…Tron} else {…}` shape the
   * sign/execute/claim tools would otherwise repeat.
   */
  const runBySessionKind = <T>(handlers: {
    evm: (deps: { client: BackendMcpClient; account: LocalAccount; session: EvmSession }) => Promise<T>;
    tvm: (deps: { client: BackendMcpClient; signer: TronSigner; session: TvmSession }) => Promise<T>;
  }): Promise<T> => {
    const session = sessions.require();
    const client = registry.clientFor(session.chainKind);
    if (session.chainKind === 'tvm') {
      const signer = keystore.requireIdentity('tvm').createSigner(session.fullHost);
      return handlers.tvm({ client, signer, session });
    }
    const account = keystore.requireIdentity('evm').account;
    return handlers.evm({ client, account, session });
  };

  return [
    {
      name: 'get_signer_addresses',
      description:
        'Return the local agent signer addresses per configured protocol as JSON — ' +
        '`{ "evm": "0x…", "tvm": "T…" }` with only the configured slots present.',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true },
      handler: async () => JSON.stringify(keystore.addresses()),
    },
    {
      name: 'select_account',
      description:
        'Select the multisig account/deployment to act on, on a target chain (defaults to the ' +
        'configured default chain when its protocol has a key). Resolves the deployment from ' +
        'get_account and the RPC from the network map, holding ' +
        '{ deploymentId, contract, chainId, rpcUrl, version } for the session. The chain kind ' +
        'picks the EVM or TVM identity; acting on a chain whose slot is empty is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account (team) id from list_accounts' },
          chainId: { type: 'number', description: 'Target chain id; defaults to the configured default chain' },
        },
        required: ['accountId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: async (args) => {
        const parsed = accountChainArgsSchema.parse(args);
        const chainId = resolveChainId(parsed.chainId);
        const kind = chainKind(chainId);
        const rpcUrl = rpcForChain(config, chainId);
        const client = registry.clientFor(kind);

        if (kind === 'tvm') {
          const details = await fetchAndAssertAccount(client, 'tvm', parsed.accountId, chainId);
          const deployment = requireDeployedDeployment(details.deployments, parsed.accountId, chainId);
          const session: AccountSession = {
            chainKind: 'tvm',
            deploymentId: deployment.deploymentId,
            contract: toTronBase58(details.account.contract),
            chainId,
            fullHost: rpcUrl,
            version: parseContractVersion(details.account.smartContractVersionId),
          };
          sessions.select(session);
          return JSON.stringify(session);
        }

        const details = await fetchAndAssertAccount(client, 'evm', parsed.accountId, chainId);
        const deployment = requireDeployedDeployment(details.deployments, parsed.accountId, chainId);
        const session: AccountSession = {
          chainKind: 'evm',
          deploymentId: deployment.deploymentId,
          contract: details.account.contract,
          chainId,
          rpcUrl,
          version: parseContractVersion(details.account.smartContractVersionId),
        };
        sessions.select(session);
        return JSON.stringify(session);
      },
    },
    {
      name: 'deploy_account',
      description:
        'Deploy the multisig on-chain: fetch CREATE2 deploy params from the backend and broadcast ' +
        'createInstance from the agent hot wallet. The backend indexer registers the deployment ' +
        '(deploymentId) with a lag after the transaction confirms.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: 'Account (team) id from list_accounts' },
          chainId: { type: 'number', description: 'Target chain id; defaults to the configured default chain' },
        },
        required: ['accountId'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      handler: async (args) => {
        const parsed = accountChainArgsSchema.parse(args);
        const chainId = resolveChainId(parsed.chainId);
        const kind = chainKind(chainId);
        const rpcUrl = rpcForChain(config, chainId);
        const client = registry.clientFor(kind);

        if (kind === 'tvm') {
          await fetchAndAssertAccount(client, 'tvm', parsed.accountId, chainId);
          const signer = keystore.requireIdentity('tvm').createSigner(rpcUrl);
          const result = await deployAccountTron(
            { client, signer, fullHost: rpcUrl, feeLimit: config.tronFeeLimit },
            parsed.accountId,
          );
          return JSON.stringify(result);
        }

        await fetchAndAssertAccount(client, 'evm', parsed.accountId, chainId);
        const account = keystore.requireIdentity('evm').account;
        const result = await deployAccount({ client, account, chainId, rpcUrl }, parsed.accountId);
        return JSON.stringify(result);
      },
    },
    {
      name: 'review_operation',
      description:
        'Decode what signing a queued operation of the selected account would authorize, from its calls alone ' +
        '(recipients, amounts, owner changes), and return { effects, warnings, requiresAllowUnknownCalls, ' +
        'unverifiedProposerFields, confirm }. Signs nothing. Show the effects and warnings to the user before ' +
        'calling sign_operation with the returned confirm.',
      inputSchema: {
        type: 'object',
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      handler: async (args) => {
        const { operationId } = operationArgsSchema.parse(args);
        const review = await runBySessionKind({
          evm: ({ client, account, session }) => reviewOperation(client, session, account.address, operationId),
          tvm: ({ client, signer, session }) => reviewOperation(client, session, signer.address, operationId),
        });
        return JSON.stringify(review);
      },
    },
    {
      name: 'sign_operation',
      description:
        'Sign a queued multisig operation with the local keystore key and submit the signature. Requires an ' +
        'account to be selected. The key never enters LLM context. Signs only when `confirm` is exactly the ' +
        '`confirm` returned by review_operation for this operation (the decoded effects the user approved); ' +
        'otherwise nothing is signed and the review is returned. An operation with calls whose effect cannot be ' +
        'decoded also needs allowUnknownCalls: true.',
      inputSchema: {
        type: 'object',
        properties: {
          operationId: { type: 'string' },
          confirm: {
            type: 'string',
            description: 'The exact `confirm` text from review_operation — the effects the user approved',
          },
          allowUnknownCalls: {
            type: 'boolean',
            description: 'Set only when the user explicitly accepts calls whose effect cannot be verified',
          },
        },
        required: ['operationId', 'confirm'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      handler: async (args) => {
        const request = signArgsSchema.parse(args);
        const result = await runBySessionKind({
          evm: ({ client, account, session }) => signOperation({ client, account, session }, request),
          tvm: ({ client, signer, session }) => signOperationTron({ client, signer, session }, request),
        });
        return JSON.stringify(result);
      },
    },
    {
      name: 'execute_operation',
      description:
        'Broadcast the on-chain execute transaction for a threshold-met operation from the agent ' +
        'hot wallet. Requires an account to be selected. Refuses to broadcast if not executable.',
      inputSchema: {
        type: 'object',
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      handler: async (args) => {
        const { operationId } = operationArgsSchema.parse(args);
        const result = await runBySessionKind({
          evm: ({ client, account, session }) => executeOperation({ client, account, session }, operationId),
          tvm: ({ client, signer, session }) =>
            executeOperationTron({ client, signer, session, feeLimit: config.tronFeeLimit }, operationId),
        });
        return JSON.stringify(result);
      },
    },
    {
      name: 'claim',
      description:
        'Claim (sweep) all claimable invoice deposits of a given currency into the selected multisig ' +
        'account, on-chain from the agent hot wallet. currencyId is the currency id from list_claims / ' +
        'list_claimable_currencies (e.g. "11155111-0x…" for a token, the bare chain id for the native ' +
        'coin). Requires an account to be selected. Unlike a payout, claim needs no signatures — it moves ' +
        'funds into the account — but it is still an irreversible on-chain transaction that costs gas.',
      inputSchema: {
        type: 'object',
        properties: {
          currencyId: { type: 'string', description: 'Currency id to claim (from list_claims)' },
        },
        required: ['currencyId'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      handler: async (args) => {
        const { currencyId } = claimArgsSchema.parse(args);
        const result = await runBySessionKind({
          evm: ({ client, account, session }) => claim({ client, account, session }, currencyId),
          tvm: ({ client, signer, session }) =>
            claimTron({ client, signer, session, feeLimit: config.tronFeeLimit }, currencyId),
        });
        return JSON.stringify(result);
      },
    },
  ];
}
