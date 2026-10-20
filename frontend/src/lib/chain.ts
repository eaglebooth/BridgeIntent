import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

export const CHAIN = {
  ...studionet,
  blockExplorers: { default: { name: "GenLayer Studio Explorer", url: "https://explorer-studio.genlayer.com" } },
};
export const EXPLORER = "https://explorer-studio.genlayer.com";
export const EXAMPLE = {
  deposit: "0x56a86610aad2a653161c9dd4b4972f948198fd02ae9589cfac1d57bd86a156c1",
  fill: "0x7965d6064d8bee154d1c5471672180f5f802f789e22f66d54102a2010121a93e",
};
export const validAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
const chainIdHex = `0x${CHAIN.id.toString(16)}`;

type Provider = {
  request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
declare global { interface Window { ethereum?: Provider } }
type Receipt = {
  statusName?: string;
  result_name?: string;
  txExecutionResultName?: string;
  consensus_data?: {
    leader_receipt?: Array<{
      mode?: string;
      execution_result?: string;
      result?: { status?: string };
      genvm_result?: { error_code?: string | null };
    }>;
    validators?: Array<{
      mode?: string;
      execution_result?: string;
      result?: { status?: string };
      genvm_result?: { error_code?: string | null };
    }>;
  };
};
type Client = {
  readContract: (input: { address: `0x${string}`; functionName: string; args: unknown[]; transactionHashVariant?: "latest-final" }) => Promise<unknown>;
  writeContract: (input: { address: `0x${string}`; functionName: string; args: unknown[]; value: bigint }) => Promise<string | { txId: string }>;
  waitForTransactionReceipt: (input: { hash: `0x${string}`; status: "FINALIZED"; interval: number; retries: number }) => Promise<Receipt>;
  getTransaction: (input: { hash: `0x${string}` }) => Promise<Receipt>;
};

const client = (provider?: Provider, account?: string) => createClient({
  chain: CHAIN,
  ...(provider && account ? { provider, account: account as `0x${string}` } : {}),
}) as unknown as Client;

function getErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? Number((error as { code: unknown }).code) : 0;
}

export async function ensureStudioNet() {
  if (!window.ethereum) throw new Error("Connect a browser wallet first.");
  const current = String(await window.ethereum.request({ method: "eth_chainId" })).toLowerCase();
  if (current === chainIdHex.toLowerCase()) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    if (getErrorCode(error) !== 4902) throw new Error("Switch the wallet to GenLayer StudioNet (61999).");
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
      chainId: chainIdHex,
      chainName: "GenLayer StudioNet",
      nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
      rpcUrls: ["https://studio.genlayer.com/api"],
      blockExplorerUrls: [EXPLORER],
    }] });
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  }
  if (String(await window.ethereum.request({ method: "eth_chainId" })).toLowerCase() !== chainIdHex.toLowerCase()) {
    throw new Error("Wallet did not switch to StudioNet.");
  }
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error("Install MetaMask or another EVM-compatible wallet.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts?.[0]) throw new Error("Wallet did not return an account.");
  await ensureStudioNet();
  return accounts[0];
}

export async function currentWallet() {
  if (!window.ethereum) return "";
  const accounts = await window.ethereum.request({ method: "eth_accounts" }) as string[];
  return accounts?.[0] ?? "";
}

export function watchWallet(listener: (address: string) => void) {
  if (!window.ethereum?.on) return () => undefined;
  const callback = (...args: unknown[]) => listener(((args[0] || []) as string[])[0] || "");
  window.ethereum.on("accountsChanged", callback);
  return () => window.ethereum?.removeListener?.("accountsChanged", callback);
}

export async function readContract<T>(address: string, method: string, args: unknown[] = []): Promise<T> {
  if (!validAddress(address)) throw new Error("Paste the deployed BridgeIntent contract address.");
  const value = await client().readContract({ address: address as `0x${string}`, functionName: method, args, transactionHashVariant: "latest-final" });
  return JSON.parse(String(value)) as T;
}

export async function readContractText(address: string, method: string, args: unknown[] = []): Promise<string> {
  if (!validAddress(address)) throw new Error("Paste the deployed BridgeIntent contract address.");
  const value = await client().readContract({ address: address as `0x${string}`, functionName: method, args, transactionHashVariant: "latest-final" });
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

export async function deriveAssessmentId(intentOwner: string, intentId: string, assessor: string, nonce: string) {
  const preimage = `${intentOwner.trim().toLowerCase()}:${intentId.trim()}:${assessor.trim().toLowerCase()}:${nonce.trim()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function writeContract(address: string, account: string, method: string, args: unknown[], update: (stage: string, hash?: string) => void) {
  if (!window.ethereum || !validAddress(address) || !validAddress(account)) throw new Error("Connect a wallet and configure the contract address.");
  await ensureStudioNet();
  const signed = client(window.ethereum, account);
  update("Waiting for wallet signature");
  const raw = await signed.writeContract({ address: address as `0x${string}`, functionName: method, args, value: 0n });
  const hash = typeof raw === "string" ? raw : raw.txId;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Wallet returned an invalid transaction hash.");
  update("Waiting for GenLayer consensus", hash);
  const receipt = await signed.waitForTransactionReceipt({ hash: hash as `0x${string}`, status: "FINALIZED", interval: 2500, retries: 360 });
  const tx = await signed.getTransaction({ hash: hash as `0x${string}` });
  const leader = (tx.consensus_data?.leader_receipt || []).find((item) => item.mode === "leader");
  const leaderSucceeded = leader?.execution_result === "SUCCESS"
    && leader.result?.status !== "contract_error"
    && !leader.genvm_result?.error_code;
  if (String(receipt.statusName || tx.statusName).toUpperCase() !== "FINALIZED"
      || String(tx.result_name || "").toUpperCase() !== "MAJORITY_AGREE"
      || !leaderSucceeded) {
    throw new Error(`Transaction finalized without successful execution. See ${EXPLORER}/tx/${hash}`);
  }
  update("Reading finalized contract state", hash);
  return hash;
}
