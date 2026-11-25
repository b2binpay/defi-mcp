import { encodeFunctionData, erc20Abi, getAddress, type Hex, maxUint160, maxUint256, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SELF_CALL_ABI,
  COW_PRE_SIGNATURE_ABI,
  PERMIT2_APPROVE_ABI,
  TOKEN_REVIEW_ABI,
} from '../contracts/review-abi.js';
import { type CallReviewContext, describeCall } from './describe-call.js';
import { toEvmHex, toTronBase58 } from './tron-address.js';

const ACCOUNT = getAddress('0x2222222222222222222222222222222222222222');
const AGENT = getAddress('0x3333333333333333333333333333333333333333');
const ATTACKER = getAddress('0x34cf29f7fc207b6b6228c3bb7a2a7b29c0fb947d');
const TOKEN = getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
const PERMIT2 = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');

const EVM: CallReviewContext = { kind: 'evm', account: ACCOUNT };
const TVM: CallReviewContext = { kind: 'tvm', account: ACCOUNT };

const selfCall = (data: Hex) => ({ to: ACCOUNT, value: '0', data });

describe('describeCall — native and ERC-20', () => {
  it('describes a plain native transfer with formatted and base units', () => {
    expect(describeCall({ to: ATTACKER, value: '1500000000000000', data: '0x' }, EVM)).toEqual({
      text: `send 0.0015 native coin (1500000000000000 wei) to ${ATTACKER}`,
      isDecoded: true,
      warnings: [],
    });
  });

  it('describes an empty zero-value call', () => {
    expect(describeCall({ to: ATTACKER, value: '0', data: '0x' }, EVM).text).toBe(
      `empty call to ${ATTACKER} (no value, no data)`,
    );
  });

  it('describes ERC-20 transfer, approve (unlimited) and transferFrom from the calldata', () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 1_000_000n] });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, maxUint256] });
    const transferFrom = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transferFrom',
      args: [ACCOUNT, ATTACKER, 5n],
    });

    expect(describeCall({ to: TOKEN, value: '0', data: transfer }, EVM)).toEqual({
      text: `transfer 1000000 base units of token ${TOKEN} to ${ATTACKER}`,
      isDecoded: true,
      warnings: [],
    });
    expect(describeCall({ to: TOKEN, value: '0', data: approve }, EVM).text).toBe(
      `approve ${ATTACKER} to spend UNLIMITED base units of token ${TOKEN} (NFT #${maxUint256} if ${TOKEN} is an ERC-721 collection)`,
    );
    expect(describeCall({ to: TOKEN, value: '0', data: transferFrom }, EVM).text).toBe(
      `transfer 5 base units of token ${TOKEN} (NFT #5 if ${TOKEN} is an ERC-721 collection) from ${ACCOUNT} to ${ATTACKER}`,
    );
  });

  it('appends native value attached to a decoded call', () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 1n] });

    expect(describeCall({ to: TOKEN, value: '1000000000000000000', data: transfer }, EVM).text).toBe(
      `transfer 1 base units of token ${TOKEN} to ${ATTACKER}, attaching 1 native coin (1000000000000000000 wei)`,
    );
  });
});

describe('describeCall — the account itself', () => {
  it('describes setConfig with the new owners and threshold', () => {
    const data = encodeFunctionData({ abi: ACCOUNT_SELF_CALL_ABI, functionName: 'setConfig', args: [[ATTACKER], 1n] });

    expect(describeCall(selfCall(data), EVM)).toEqual({
      text: `set account owners to [${ATTACKER}] with threshold 1`,
      isDecoded: true,
      warnings: [],
      setConfig: { owners: [ATTACKER], threshold: 1n },
    });
  });

  it('describes whitelist changes and claims to another address', () => {
    const whitelist = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'setWhitelist',
      args: [
        [AGENT, ATTACKER],
        [true, false],
      ],
    });
    const claimTo = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'claimTo',
      args: [TOKEN, ATTACKER, [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]],
    });

    expect(describeCall(selfCall(whitelist), EVM).text).toBe(
      `update the claim whitelist: add [${AGENT}], remove [${ATTACKER}]`,
    );
    expect(describeCall(selfCall(claimTo), EVM).text).toBe(
      `claim 2 deposit(s) [0x${'11'.repeat(32)}, 0x${'22'.repeat(32)}]: move the whole balance of token ${TOKEN} and the whole native coin balance of each to ${ATTACKER}`,
    );
  });

  it('lists every claimed deposit id and the native balance each one sends', () => {
    const ids: Hex[] = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`];
    const claimToken = encodeFunctionData({ abi: ACCOUNT_SELF_CALL_ABI, functionName: 'claim', args: [TOKEN, ids] });
    const claimNative = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'claim',
      args: [zeroAddress, ids.slice(0, 1)],
    });

    expect(describeCall(selfCall(claimToken), EVM).text).toBe(
      `claim 2 deposit(s) [${ids.join(', ')}]: move the whole balance of token ${TOKEN} and the whole native coin balance of each into this account`,
    );
    expect(describeCall(selfCall(claimNative), TVM).text).toBe(
      `claim 1 deposit(s) [${ids[0]}]: move the whole TRX balance of each into this account`,
    );
  });

  it('does not decode multisig selectors on a contract other than the account', () => {
    const data = encodeFunctionData({ abi: ACCOUNT_SELF_CALL_ABI, functionName: 'setConfig', args: [[ATTACKER], 1n] });

    const described = describeCall({ to: TOKEN, value: '0', data }, EVM);

    expect(described.isDecoded).toBe(false);
    expect(described.text).toMatch(/^UNKNOWN call to /);
  });

  it('describes TRON staking with TRX units, resource names and base58 addresses', () => {
    const freeze = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'freezeBalanceV2',
      args: [1_000_000_000n, 1n],
    });
    const delegate = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'delegateResource',
      args: [2_000_000n, ATTACKER, 0n],
    });

    expect(describeCall(selfCall(freeze), TVM).text).toBe('stake 1000 TRX (1000000000 sun) for ENERGY');
    expect(describeCall(selfCall(delegate), TVM).text).toBe(
      `delegate BANDWIDTH of 2 TRX (2000000 sun) to ${toTronBase58(ATTACKER)}`,
    );
  });

  it('accepts a base58 call target on TVM and shows TRX transfers in base58', () => {
    const target = toTronBase58(ATTACKER);

    expect(describeCall({ to: target, value: '1000', data: '0x' }, TVM).text).toBe(
      `send 0.001 TRX (1000 sun) to ${target}`,
    );
    expect(toEvmHex(target)).toBe(ATTACKER);
  });
});

describe('describeCall — not fully decodable', () => {
  it('marks a CoW pre-signature as opaque', () => {
    const orderUid: Hex = `0x${'ab'.repeat(20)}`; // not the 56-byte uid layout
    const data = encodeFunctionData({
      abi: COW_PRE_SIGNATURE_ABI,
      functionName: 'setPreSignature',
      args: [orderUid, true],
    });

    const described = describeCall({ to: TOKEN, value: '0', data }, EVM);

    expect(described.isDecoded).toBe(false);
    expect(described.text).toBe(
      `pre-sign CoW order ${orderUid} at ${TOKEN}; the order terms (amounts, receiver) are not in the call`,
    );
  });

  it('shows the digest, owner and expiry of a well-formed CoW order uid', () => {
    const digest: Hex = `0x${'cd'.repeat(32)}`;
    const validTo = '6a2bf8c0'; // 1781266624 = 2026-06-12T12:17:04.000Z
    const orderUid: Hex = `${digest}${ACCOUNT.slice(2).toLowerCase()}${validTo}`;
    const data = encodeFunctionData({
      abi: COW_PRE_SIGNATURE_ABI,
      functionName: 'setPreSignature',
      args: [orderUid, true],
    });

    expect(describeCall({ to: TOKEN, value: '0', data }, EVM).text).toBe(
      `pre-sign CoW order ${digest} (owner ${ACCOUNT}, valid until 2026-06-12T12:17:04.000Z) at ${TOKEN}; ` +
        'the order terms (amounts, receiver) are not in the call',
    );
  });

  it('describes an unknown selector with its size, hash and value', () => {
    const described = describeCall({ to: ATTACKER, value: '7', data: '0xdeadbeef00' }, EVM);

    expect(described.isDecoded).toBe(false);
    expect(described.text).toMatch(
      new RegExp(
        `^UNKNOWN call to ${ATTACKER}: selector 0xdeadbeef, 5 bytes of data \\(keccak256 0x[0-9a-f]{64}\\), value 0.000000000000000007 native coin \\(7 wei\\)$`,
      ),
    );
  });
});

describe('describeCall — risky grants carry a warning', () => {
  it('warns on an allowance granted to anyone but the account', () => {
    const unlimited = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, maxUint256] });
    const toAccount = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACCOUNT, maxUint256] });

    expect(describeCall({ to: TOKEN, value: '0', data: unlimited }, EVM).warnings).toEqual([
      `grants ${ATTACKER} an allowance of UNLIMITED base units of token ${TOKEN} (NFT #${maxUint256} if ${TOKEN} is an ERC-721 collection)`,
    ]);
    expect(describeCall({ to: TOKEN, value: '0', data: toAccount }, EVM).warnings).toEqual([]);
  });

  it('warns on approve(spender, 0), which grants NFT #0 on an ERC-721 collection; only a zero spender is harmless', () => {
    const nftZero = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, 0n] });
    const clear = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [zeroAddress, 7n] });

    expect(describeCall({ to: TOKEN, value: '0', data: nftZero }, EVM)).toEqual({
      text: `approve ${ATTACKER} to spend 0 base units of token ${TOKEN} (NFT #0 if ${TOKEN} is an ERC-721 collection)`,
      isDecoded: true,
      warnings: [`grants ${ATTACKER} control of NFT #0 of ${TOKEN} if it is an ERC-721 collection`],
    });
    expect(describeCall({ to: TOKEN, value: '0', data: clear }, EVM).warnings).toEqual([]);
  });

  it('decodes increaseAllowance and setApprovalForAll with a warning each', () => {
    const increase = encodeFunctionData({
      abi: TOKEN_REVIEW_ABI,
      functionName: 'increaseAllowance',
      args: [ATTACKER, 5n],
    });
    const approveAll = encodeFunctionData({
      abi: TOKEN_REVIEW_ABI,
      functionName: 'setApprovalForAll',
      args: [ATTACKER, true],
    });

    expect(describeCall({ to: TOKEN, value: '0', data: increase }, EVM)).toEqual({
      text: `increase the allowance of ${ATTACKER} by 5 base units of token ${TOKEN}`,
      isDecoded: true,
      warnings: [`grants ${ATTACKER} 5 base units of token ${TOKEN} more allowance`],
    });
    expect(describeCall({ to: TOKEN, value: '0', data: approveAll }, EVM)).toEqual({
      text: `let ${ATTACKER} transfer every token of collection ${TOKEN}`,
      isDecoded: true,
      warnings: [`grants ${ATTACKER} control of every token of collection ${TOKEN}`],
    });
  });

  it('decodes a Permit2 approve with its token, spender, amount and expiry', () => {
    const data = encodeFunctionData({
      abi: PERMIT2_APPROVE_ABI,
      functionName: 'approve',
      args: [TOKEN, ATTACKER, maxUint160, 1781266624],
    });

    expect(describeCall({ to: PERMIT2, value: '0', data }, EVM)).toEqual({
      text: `Permit2 ${PERMIT2}: allow ${ATTACKER} to pull UNLIMITED base units of token ${TOKEN} until 2026-06-12T12:17:04.000Z`,
      isDecoded: true,
      warnings: [`grants ${ATTACKER} a Permit2 allowance of UNLIMITED base units of token ${TOKEN}`],
    });
  });

  it('warns on transferFrom to someone else and on claimTo an address other than the account', () => {
    const pull = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [AGENT, ATTACKER, 7n] });
    const claimTo = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'claimTo',
      args: [zeroAddress, ATTACKER, [`0x${'11'.repeat(32)}`]],
    });
    const claimHome = encodeFunctionData({
      abi: ACCOUNT_SELF_CALL_ABI,
      functionName: 'claimTo',
      args: [zeroAddress, ACCOUNT, [`0x${'11'.repeat(32)}`]],
    });

    expect(describeCall({ to: TOKEN, value: '0', data: pull }, EVM).warnings).toEqual([
      `pulls 7 base units of token ${TOKEN} (NFT #7 if ${TOKEN} is an ERC-721 collection) from ${AGENT} to ${ATTACKER}`,
    ]);
    expect(describeCall(selfCall(claimTo), EVM).warnings).toEqual([
      `sends claimed deposits to ${ATTACKER}, not to this account`,
    ]);
    expect(describeCall(selfCall(claimHome), EVM).warnings).toEqual([]);
  });
});
