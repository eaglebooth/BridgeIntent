import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowDownLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, Copy, ExternalLink, Fingerprint, Layers3, LoaderCircle, Radio, ShieldCheck, Wallet, X } from "lucide-react";
import { CHAIN, EXAMPLE, EXPLORER, connectWallet, currentWallet, deriveAssessmentId, readContract, readContractText, validAddress, watchWallet, writeContract } from "../lib/chain";

type Intent = {
  owner: string; intent_id: string; origin_chain_id: number; destination_chain_id: number;
  expected_action: string; intent_digest: string; deposit_tx: string; fill_tx: string; evidence_bound: boolean;
};
type Assessment = {
  assessment_id: string; intent_owner: string; intent_id: string; assessor: string; nonce: string;
  status: string; verdict: string; reason: string; facts_json: string; facts_digest: string;
};
type Stats = { intent_count: number; assessment_count: number };
const envAddress = import.meta.env.VITE_BRIDGEINTENT_ADDRESS || "";
const abbreviate = (value: string) => value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
const makeNonce = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function App() {
  const [wallet, setWallet] = useState("");
  const [contract, setContract] = useState(envAddress || localStorage.getItem("bridgeintent.contract") || "");
  const [intentId, setIntentId] = useState(`bridge-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`);
  const [goal, setGoal] = useState("The linked receipt pair shows the declared token delivered to the destination recipient.");
  const [originChain, setOriginChain] = useState("42161");
  const [destinationChain, setDestinationChain] = useState("8453");
  const [depositTx, setDepositTx] = useState("");
  const [fillTx, setFillTx] = useState("");
  const [activeIntent, setActiveIntent] = useState<Intent | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [schemaState, setSchemaState] = useState({ address: "", version: "", error: false });
  const [pending, setPending] = useState("");
  const [transaction, setTransaction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const schemaRequestId = useRef(0);
  const addressReady = validAddress(contract);
  const schemaReady = schemaState.address === contract.trim().toLowerCase() && schemaState.version === "bridgeintent/2";
  const chainLabel = (id: string | number) => Number(id) === 42161 ? "Arbitrum One" : Number(id) === 8453 ? "Base" : `Chain ${id}`;

  const refreshStats = useCallback(async () => {
    const requestId = ++schemaRequestId.current;
    if (!addressReady) { setStats(null); return; }
    try {
      const [nextStats, schema] = await Promise.all([
        readContract<Stats>(contract, "get_stats"),
        readContractText(contract, "get_schema_version"),
      ]);
      if (requestId !== schemaRequestId.current) return;
      setStats(nextStats);
      setSchemaState({ address: contract.trim().toLowerCase(), version: schema, error: false });
    } catch {
      if (requestId !== schemaRequestId.current) return;
      setStats(null);
      setSchemaState({ address: contract.trim().toLowerCase(), version: "", error: true });
    }
  }, [addressReady, contract]);

  useEffect(() => {
    void currentWallet().then(setWallet).catch(() => undefined);
    const unwatch = watchWallet((address) => {
      setWallet(address);
      setActiveIntent(null);
      setAssessment(null);
      setTransaction("");
      setNotice("");
      setError("");
    });
    return unwatch;
  }, []);
  useEffect(() => { void refreshStats(); }, [refreshStats]);
  useEffect(() => { localStorage.setItem("bridgeintent.contract", contract); }, [contract]);

  const txLink = (tx: string, chain: string | number) => `${Number(chain) === 42161 ? "https://arbiscan.io" : "https://basescan.org"}/tx/${tx}`;
  const nextWrite = async (method: string, args: unknown[], success: string) => {
    setError(""); setNotice(""); setTransaction(""); setPending(method);
    try {
      const hash = await writeContract(contract, wallet, method, args, (stage, tx) => { setNotice(stage); if (tx) setTransaction(tx); });
      setTransaction(hash);
      setNotice(success);
      await refreshStats();
      return hash;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transaction failed.");
      return "";
    } finally { setPending(""); }
  };

  const openIntent = async () => {
    if (!wallet) return setError("Connect your wallet first.");
    const id = intentId.trim();
    const nonce = makeNonce("intent");
    const hash = await nextWrite("create_intent", [id, BigInt(originChain), BigInt(destinationChain), goal, nonce], "Intent sealed on GenLayer.");
    if (!hash) return;
    try {
      const saved = await readContract<Intent>(contract, "get_intent", [wallet, id]);
      setActiveIntent(saved); setAssessment(null); setNotice("Intent created and confirmed by finalized contract readback.");
    } catch { setError("The transaction finalized, but the intent readback is not available yet."); }
  };

  const loadIntent = async () => {
    setError(""); setNotice("");
    try {
      const saved = await readContract<Intent>(contract, "get_intent", [wallet, intentId.trim()]);
      setActiveIntent(saved); setOriginChain(String(saved.origin_chain_id)); setDestinationChain(String(saved.destination_chain_id));
      setGoal(saved.expected_action); setDepositTx(saved.deposit_tx); setFillTx(saved.fill_tx); setAssessment(null);
      setNotice("Intent loaded from finalized StudioNet state.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Intent not found for this wallet."); }
  };

  const bindEvidence = async () => {
    if (!activeIntent) return setError("Create or load an intent first.");
    const hash = await nextWrite("bind_evidence", [wallet, activeIntent.intent_id, depositTx.trim(), fillTx.trim()], "Evidence hashes bound to the immutable intent.");
    if (!hash) return;
    try { setActiveIntent(await readContract<Intent>(contract, "get_intent", [wallet, activeIntent.intent_id])); }
    catch { setError("The transaction finalized, but evidence binding readback is pending."); }
  };

  const assess = async () => {
    if (!activeIntent) return setError("Create or load an intent first.");
    const nonce = makeNonce("review");
    setAssessment(null);
    const txHash = await nextWrite("assess", [wallet, activeIntent.intent_id, nonce], "GenLayer assessment finalized.");
    if (!txHash) return;
    try {
      const id = await deriveAssessmentId(wallet, activeIntent.intent_id, wallet, nonce);
      const result = await readContract<Assessment>(contract, "get_assessment", [id]);
      if (result.assessment_id !== id
          || result.intent_owner.toLowerCase() !== wallet.toLowerCase()
          || result.intent_id !== activeIntent.intent_id
          || result.assessor.toLowerCase() !== wallet.toLowerCase()
          || result.nonce !== nonce) {
        throw new Error("Finalized assessment readback does not match this wallet, intent, and nonce.");
      }
      setAssessment(result); setNotice("Assessment displayed after finalized state readback.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The transaction finalized, but assessment readback is still pending. Use its transaction hash to retry."); }
  };

  const loadSample = () => {
    setDepositTx(EXAMPLE.deposit); setFillTx(EXAMPLE.fill);
    setNotice("Loaded a publicly verifiable Across receipt pair. Its depositor is a third party; this case does not claim their identity or ownership.");
    setError("");
  };

  const verdictClass = useMemo(() => assessment?.verdict.toLowerCase() ?? "", [assessment]);
  const copy = async (value: string) => { await navigator.clipboard.writeText(value); setNotice("Copied to clipboard."); };

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="BridgeIntent home"><img src="/bridgeintent-mark.png" alt="" /><span>bridge<span>intent</span></span></a>
      <nav><a className="nav-active" href="#workspace">Workbench</a><a href="#how-it-works">How it works</a><a href="https://docs.across.to/introduction/tracking-deposits" target="_blank" rel="noreferrer">Protocol source <ArrowUpRight size={13}/></a></nav>
      <button className={`wallet-button ${wallet ? "connected" : ""}`} onClick={async () => { setError(""); try { setWallet(await connectWallet()); } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed."); } }}>
        <Wallet size={16}/>{wallet ? abbreviate(wallet) : "Connect wallet"}
      </button>
    </header>

    <main id="top">
      <section className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow"><span className="live-dot"/> GENLAYER INTELLIGENT CONTRACTS <span className="eyebrow-line"/></div>
          <h1>Make the destination<br/><em>make sense.</em></h1>
          <p>Submit any public Across deposit/fill pair. The contract verifies the receipts, then GenLayer interprets whether the observed destination action matches the declared outcome.</p>
          <div className="hero-meta"><span><ShieldCheck size={15}/> Evidence-first</span><span><Layers3 size={15}/> Arbitrum ↔ Base</span><span><Fingerprint size={15}/> Public receipt checks</span></div>
        </div>
        <div className="hero-art"><div className="art-orbit orbit-a"/><div className="art-orbit orbit-b"/><img src="/bridgeintent-mark.png" alt="BridgeIntent mark: CVE document, network links and a verified Ethereum record"/><div className="art-caption"><span>01 / receipt</span><span>consensus-bound</span></div></div>
      </section>

      <section className="workspace" id="workspace">
        <div className="section-head"><div><div className="eyebrow dark"><span className="step-index">01</span> ASSESSMENT WORKSPACE</div><h2>A receipt, not a promise.</h2></div><div className="stats-strip"><div><strong>{stats?.intent_count ?? "—"}</strong><span>intents</span></div><div><strong>{stats?.assessment_count ?? "—"}</strong><span>assessments</span></div></div></div>
        <div className="workspace-grid">
          <div className="form-column">
            <section className="panel">
              <div className="panel-heading"><span className="panel-number">A</span><div><h3>Declare the expected outcome</h3><p>Stored under the submitter wallet. This does not claim ownership of the source transaction.</p></div></div>
              <label className="field-label" htmlFor="contract">STUDIONET CONTRACT</label>
              <input id="contract" className="mono" value={contract} onChange={(e) => { schemaRequestId.current++; setContract(e.target.value.trim()); setStats(null); setActiveIntent(null); setAssessment(null); setTransaction(""); setNotice(""); setError(""); }} placeholder="Paste deployed BridgeIntent address" spellCheck={false}/>
              {addressReady && <p className="fine-print" role="status">{schemaReady ? "Detected bridgeintent/2. Public verification is enabled." : schemaState.address === contract.trim().toLowerCase() && schemaState.error ? "Could not verify this contract schema; writes are disabled." : schemaState.address === contract.trim().toLowerCase() && schemaState.version ? "Detected " + schemaState.version + ". Public verification requires bridgeintent/2; writes are disabled." : "Checking contract schema…"}</p>}
              <div className="field-row">
                <div className="field-grow"><label className="field-label" htmlFor="intent-id">INTENT ID</label><div className="input-with-button"><input id="intent-id" value={intentId} onChange={(e) => setIntentId(e.target.value)} maxLength={64}/><button className="small-ghost" onClick={loadIntent} disabled={!wallet || !addressReady}>Load</button></div></div>
                <div className="field-grow"><label className="field-label" htmlFor="origin">ROUTE</label><div className="route-select"><select id="origin" value={originChain} onChange={(e) => setOriginChain(e.target.value)}><option value="42161">Arbitrum One</option><option value="8453">Base</option></select><ArrowDown size={14}/><select aria-label="Destination chain" value={destinationChain} onChange={(e) => setDestinationChain(e.target.value)}><option value="8453">Base</option><option value="42161">Arbitrum One</option></select></div></div>
              </div>
              <label className="field-label" htmlFor="goal">EXPECTED DESTINATION ACTION</label>
              <textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={500} placeholder="Describe the destination action (20–500 characters)." rows={3}/>
              <div className="field-footer"><span>Case submitted by {wallet ? abbreviate(wallet) : "your connected wallet"} · 20 character minimum</span><span>{goal.length}/500</span></div>
              <div className="panel-actions"><button className="primary-button" onClick={openIntent} disabled={!wallet || !addressReady || !schemaReady || Boolean(pending)}>{pending === "create_intent" ? <LoaderCircle className="spin" size={16}/> : <Fingerprint size={16}/>}Seal intent</button><span className="action-hint">The connected wallet submits a public case; it does not claim transaction ownership.</span></div>
            </section>

            <section className={`panel ${!activeIntent ? "panel-muted" : ""}`}>
              <div className="panel-heading"><span className="panel-number">B</span><div><h3>Attach public bridge evidence</h3><p>Anyone may submit public hashes; the contract verifies and links the receipts itself.</p></div></div>
              <label className="field-label" htmlFor="deposit">ORIGIN DEPOSIT · {chainLabel(originChain).toUpperCase()}</label>
              <input id="deposit" className="mono" value={depositTx} onChange={(e) => setDepositTx(e.target.value)} placeholder="0x… origin transaction hash" spellCheck={false}/>
              <label className="field-label" htmlFor="fill">DESTINATION FILL · {chainLabel(destinationChain).toUpperCase()}</label>
              <input id="fill" className="mono" value={fillTx} onChange={(e) => setFillTx(e.target.value)} placeholder="0x… fill transaction hash" spellCheck={false}/>
              <div className="panel-actions split-actions"><button className="primary-button" onClick={bindEvidence} disabled={!activeIntent || !wallet || !schemaReady || Boolean(pending) || activeIntent?.evidence_bound}>{pending === "bind_evidence" ? <LoaderCircle className="spin" size={16}/> : <ArrowDownLeft size={16}/>}Bind evidence</button><button className="text-button" onClick={loadSample}>Use verified public pair <ArrowUpRight size={14}/></button></div>
              {activeIntent?.evidence_bound && <div className="bound-evidence"><Check size={15}/><span>Immutable hash pair is attached.</span><a href={txLink(activeIntent.deposit_tx, activeIntent.origin_chain_id)} target="_blank" rel="noreferrer">Deposit explorer <ExternalLink size={12}/></a><a href={txLink(activeIntent.fill_tx, activeIntent.destination_chain_id)} target="_blank" rel="noreferrer">Fill explorer <ExternalLink size={12}/></a></div>}
            </section>

            <section className={`panel assess-panel ${!activeIntent?.evidence_bound ? "panel-muted" : ""}`}>
              <div className="panel-heading"><span className="panel-number">C</span><div><h3>Ask the validators</h3><p>Independent RPC reads first; semantic judgment only after the event pair links.</p></div></div>
              <button className="primary-button dark-button" onClick={assess} disabled={!activeIntent?.evidence_bound || !wallet || !schemaReady || Boolean(pending)}>{pending === "assess" ? <LoaderCircle className="spin" size={16}/> : <Radio size={16}/>}Run consensus assessment<ChevronRight size={16}/></button>
              <p className="fine-print">Every caller gets an independent receipt keyed by their wallet and nonce. A third party cannot lock your intent or replace its evidence.</p>
            </section>
          </div>

          <aside className="result-column">
            <div className="receipt-card">
              <div className="receipt-top"><span>CONSENSUS RECEIPT</span><span className={`receipt-state ${assessment ? verdictClass : "idle"}`}><i/>{assessment?.verdict ?? "AWAITING"}</span></div>
              {!assessment ? <div className="empty-receipt"><div className="empty-mark"><img src="/bridgeintent-mark.png" alt=""/></div><h3>No assessment yet</h3><p>Complete A, B, and C. The result appears only after a finalized transaction and contract readback.</p><div className="receipt-line"><span>NETWORK</span><b>GenLayer StudioNet · {CHAIN.id}</b></div></div> : <div className="receipt-body">
                <div className={`verdict-icon ${verdictClass}`}>{assessment.verdict === "MATCH" ? <Check size={22}/> : assessment.verdict === "DIVERGED" ? <X size={22}/> : <CircleAlert size={22}/>}</div>
                <h3>{assessment.verdict === "MATCH" ? "Observed action aligns" : assessment.verdict === "DIVERGED" ? "Outcome differs from goal" : "Evidence is inconclusive"}</h3>
                <p>{assessment.reason}</p>
                <div className="receipt-line"><span>ASSESSMENT</span><b className="mono">{abbreviate(assessment.assessment_id)}</b><button className="icon-button" onClick={() => void copy(assessment.assessment_id)} aria-label="Copy receipt id"><Copy size={14}/></button></div>
                <div className="receipt-line"><span>ASSESSOR</span><b className="mono">{abbreviate(assessment.assessor)}</b></div>
                {assessment.facts_digest && <div className="receipt-line"><span>FACTS SHA-256</span><b className="mono">{assessment.facts_digest.slice(0, 18)}…</b></div>}
                {transaction && <a className="transaction-link" href={`${EXPLORER}/tx/${transaction}`} target="_blank" rel="noreferrer">View GenLayer transaction <ExternalLink size={14}/></a>}
              </div>}
              <div className="receipt-bottom"><span><span className="lock-dot"/> PUBLIC RECEIPTS · SUBMITTER-INDEXED</span><span>BRI / 02</span></div>
            </div>

            <div className="source-card">
              <div className="source-head"><span className="source-glyph">↗</span><div><h4>Grounding sources</h4><p>Only fixed public JSON-RPC endpoints. No Across API key or user URL.</p></div></div>
              <div className="source-row"><span className="source-chain arb">A</span><div><b>Arbitrum One RPC</b><small>eth_chainId · tx · receipt · finalized block</small></div><span className="source-id">42161</span></div>
              <div className="source-row"><span className="source-chain base">B</span><div><b>Base RPC</b><small>eth_chainId · tx · receipt · finalized block</small></div><span className="source-id">8453</span></div>
              <a className="source-doc" href="https://docs.across.to/introduction/tracking-deposits" target="_blank" rel="noreferrer">Across event specification <ExternalLink size={13}/></a>
            </div>
          </aside>
        </div>

        {(notice || error) && <div className={`toast ${error ? "toast-error" : ""}`} role="status">{error ? <CircleAlert size={16}/> : <Check size={16}/>}<span>{error || notice}{transaction && !error && <a href={`${EXPLORER}/tx/${transaction}`} target="_blank" rel="noreferrer">Open tx <ExternalLink size={12}/></a>}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss"><X size={15}/></button></div>}
      </section>

      <section className="method-section" id="how-it-works"><div className="method-title"><div className="eyebrow dark"><span className="step-index">02</span> BOUNDED BY DESIGN</div><h2>Facts first. Judgment second.</h2><p>BridgeIntent is an interpreter over a specific Across V3 receipt pair—not a bridge, claims desk, or custody layer.</p></div>
        <div className="method-steps"><article><span>01</span><h3>Submit</h3><p>Any wallet creates a public case and attaches transaction hashes. The submitter need not be the depositor.</p></article><article><span>02</span><h3>Verify</h3><p>Validators query each chain independently, check finality, SpokePool events, deposit ID, chain pair and required relay fields.</p></article><article><span>03</span><h3>Interpret</h3><p>Consensus classifies only whether the effective destination action matches the declared goal. Missing or conflicting facts fail closed.</p></article></div>
        <div className="boundary-note"><ShieldCheck size={18}/><p><b>What it does not prove:</b> who submitted the case owns the transaction, that the goal existed before the bridge deposit, the bridge is solvent, a refund is due, or any fact outside the verified receipts.</p></div>
      </section>
    </main>
    <footer><a className="brand footer-brand" href="#top"><img src="/bridgeintent-mark.png" alt=""/><span>bridge<span>intent</span></span></a><span>Evidence-bound interpretation on GenLayer · no custody · no admin assessment gate</span><span>STUDIONET / 61999</span></footer>
  </div>;
}
