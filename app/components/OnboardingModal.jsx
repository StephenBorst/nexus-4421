import { useState, useEffect, useCallback } from "react";

const highlightDepositButton = () => {
  removeDepositHighlight();
  const btn = document.querySelector('[data-testid="oui-testid-portfolio-assets-deposit-btn"]');
  if (!btn) { setTimeout(highlightDepositButton, 1500); return; }
  if (!document.getElementById("ntl-highlight-styles")) {
    const style = document.createElement("style");
    style.id = "ntl-highlight-styles";
    style.textContent = `
      .ntl-deposit-wrapper { position: relative; display: inline-block; }
      .ntl-deposit-ring { position: absolute; inset: -6px; border-radius: 8px; border: 2px solid #00ff88; pointer-events: none; z-index: 9998; animation: ntl-ring 1.5s ease-in-out infinite; }
      @keyframes ntl-ring { 0%,100% { opacity:1; box-shadow: 0 0 0 0 rgba(0,255,136,0.4); } 50% { opacity:0.6; box-shadow: 0 0 0 8px rgba(0,255,136,0); } }
      .ntl-deposit-tip { position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%); background: #00ff88; color: #000; font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.1em; padding: 5px 10px; white-space: nowrap; pointer-events: none; z-index: 9999; }
      .ntl-deposit-tip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: #00ff88; }
    `;
    document.head.appendChild(style);
  }
  const wrapper = document.createElement("div");
  wrapper.className = "ntl-deposit-wrapper";
  wrapper.id = "ntl-deposit-wrapper";
  btn.parentNode.insertBefore(wrapper, btn);
  wrapper.appendChild(btn);
  const ring = document.createElement("div");
  ring.className = "ntl-deposit-ring";
  wrapper.appendChild(ring);
  const tip = document.createElement("div");
  tip.className = "ntl-deposit-tip";
  tip.textContent = "DEPOSIT HERE →";
  wrapper.appendChild(tip);
  btn.addEventListener("click", removeDepositHighlight, { once: true });
  window.__ntlHighlightTimeout = setTimeout(removeDepositHighlight, 10000);
};

const removeDepositHighlight = () => {
  clearTimeout(window.__ntlHighlightTimeout);
  const wrapper = document.getElementById("ntl-deposit-wrapper");
  if (wrapper) {
    const btn = wrapper.querySelector("button");
    if (btn) wrapper.parentNode.insertBefore(btn, wrapper);
    wrapper.remove();
  }
};

const STEPS = [
  { id: 1, tag: "STEP_01 / 03", title: "Connect Your Wallet", subtitle: "Non-custodial. Your keys, your funds.", description: "Connect any EVM wallet (MetaMask, Rabby, WalletConnect) or Solana wallet. Nexus never holds your assets — all positions are settled on-chain.", cta: "Connect Wallet", icon: (<svg viewBox="0 0 40 40" fill="none" style={{ width: 38, height: 38 }}><rect x="4" y="10" width="32" height="22" rx="3" stroke="#00ff88" strokeWidth="1.5" /><path d="M4 16h32" stroke="#00ff88" strokeWidth="1.5" /><circle cx="28" cy="23" r="2.5" fill="#00ff88" /></svg>) },
  { id: 2, tag: "STEP_02 / 03", title: "Deposit USDC", subtitle: "Any chain. No bridging. No hassle.", description: "Send USDC from Ethereum, Arbitrum, Base, Optimism, Solana, or any EVM chain. Keep a small amount of ETH on your source chain for gas. Arbitrum is the default.", cta: "Show Me Where", icon: (<svg viewBox="0 0 40 40" fill="none" style={{ width: 38, height: 38 }}><circle cx="20" cy="20" r="14" stroke="#00ff88" strokeWidth="1.5" /><path d="M20 10v20M14 15h9a3 3 0 010 6h-6a3 3 0 010 6h10" stroke="#00ff88" strokeWidth="1.5" strokeLinecap="round" /></svg>) },
  { id: 3, tag: "STEP_03 / 03", title: "Place Your First Trade", subtitle: "93+ markets. Up to 100x leverage.", description: "Trade crypto perpetuals, RWAs, and equities on-chain. Pro-grade execution powered by Orderly Network on Arbitrum. No custodians. No compromises.", cta: "Launch App", icon: (<svg viewBox="0 0 40 40" fill="none" style={{ width: 38, height: 38 }}><polyline points="4,30 14,18 22,24 36,8" stroke="#00ff88" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><polyline points="28,8 36,8 36,16" stroke="#00ff88" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>) },
];

const CHAINS = ["Arbitrum", "Ethereum", "Base", "Optimism", "Solana", "Any EVM"];

export default function OnboardingModal({ onComplete, onSkip }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [chainIdx, setChainIdx] = useState(0);

  useEffect(() => { const t = setTimeout(() => setVisible(true), 100); return () => clearTimeout(t); }, []);
  useEffect(() => { if (step !== 1) return; const interval = setInterval(() => setChainIdx((i) => (i + 1) % CHAINS.length), 1200); return () => clearInterval(interval); }, [step]);

  const handleClose = useCallback(() => { setExiting(true); setTimeout(() => onSkip?.(), 400); }, [onSkip]);
  const handleNext = useCallback(() => {
    if (step === 1) { setExiting(true); setTimeout(() => { onComplete?.(); highlightDepositButton(); }, 400); return; }
    if (step === STEPS.length - 1) { setExiting(true); setTimeout(() => onComplete?.(), 400); return; }
    setStep((s) => s + 1);
  }, [step, onComplete]);

  const current = STEPS[step];

  return (
    <> 
      <style>{` 
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Syne:wght@700;800&display=swap');
        .ntl-ov{position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .4s ease;font-family:'IBM Plex Mono',monospace;padding:16px}
        .ntl-ov.v{opacity:1}.ntl-ov.x{opacity:0;pointer-events:none}
        .ntl-m{position:relative;width:500px;max-width:100%;background:#0c0c0c;border:1px solid #1e1e1e;overflow:hidden;transform:translateY(20px);transition:transform .4s cubic-bezier(.16,1,.3,1)}
        .ntl-ov.v .ntl-m{transform:translateY(0)}
        .ntl-sc{position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#00ff88,transparent);animation:sc 4s linear infinite;opacity:.5;pointer-events:none}
        @keyframes sc{0%{top:0}100%{top:100%}}
        .ntl-co{position:absolute;width:10px;height:10px;border-color:#00ff88;border-style:solid;opacity:.5}
        .tl{top:6px;left:6px;border-width:1px 0 0 1px}.tr{top:6px;right:6px;border-width:1px 1px 0 0}
        .bl{bottom:6px;left:6px;border-width:0 0 1px 1px}.br{bottom:6px;right:6px;border-width:0 1px 1px 0}
        .ntl-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 12px;border-bottom:1px solid #111}
        .ntl-br2{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:.18em;color:#3a3a3a}
        .ntl-dt{width:6px;height:6px;background:#00ff88;border-radius:50%;animation:dt 2s ease-in-out infinite}
        @keyframes dt{0%,100%{opacity:1}50%{opacity:.3}}
        .ntl-xb{background:none;border:1px solid #1e1e1e;color:#3a3a3a;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;font-family:inherit;transition:all .2s}
        .ntl-xb:hover{border-color:#444;color:#777}
        .ntl-pg{display:flex;gap:4px;padding:10px 18px 0}
        .ntl-pb{height:2px;flex:1;background:#141414;transition:background .4s}
        .ntl-pb.a{background:#00ff88}.ntl-pb.d{background:#007744}
        .ntl-bd{padding:26px 18px 22px;animation:fi .3s ease}
        @keyframes fi{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
        .ntl-tg{font-size:9px;letter-spacing:.2em;color:#00ff88;opacity:.6;margin-bottom:14px}
        .ntl-ic{margin-bottom:18px}
        .ntl-tl2{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;color:#efefef;line-height:1.1;margin-bottom:6px;letter-spacing:-.02em}
        .ntl-sb{font-size:10px;letter-spacing:.14em;color:#00ff88;margin-bottom:14px}
        .ntl-dc{font-size:12px;line-height:1.75;color:#555;margin-bottom:20px}
        .ntl-chs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}
        .ntl-ch{font-size:9px;letter-spacing:.1em;padding:4px 8px;border:1px solid #1a2e20;color:#00aa55;background:#0a1a0e;transition:all .3s}
        .ntl-ch.ac{border-color:#00ff88;color:#00ff88;background:#0d2015}
        .ntl-ac{display:flex;gap:8px}
        .ntl-ct{flex:1;background:#00ff88;color:#000;border:none;padding:12px 16px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:opacity .2s}
        .ntl-ct:hover{opacity:.85}
        .ntl-sk{background:none;border:1px solid #1a1a1a;color:#2e2e2e;padding:12px 14px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.1em;cursor:pointer;transition:all .2s;white-space:nowrap}
        .ntl-sk:hover{border-color:#333;color:#555}
        .ntl-ft{padding:10px 18px;border-top:1px solid #0d0d0d;display:flex;align-items:center;gap:6px}
        .ntl-fx{font-size:9px;color:#222;letter-spacing:.07em}
        .ntl-fl{font-size:9px;color:#2e2e2e;letter-spacing:.07em;text-decoration:underline;cursor:pointer;background:none;border:none;font-family:inherit;padding:0}
        .ntl-fl:hover{color:#555}
      `}</style>
      <div className={`ntl-ov ${visible ? "v" : ""} ${exiting ? "x" : ""}`}> 
        <div className="ntl-m">
          <div className="ntl-sc" />
          <div className="ntl-co tl" /><div className="ntl-co tr" />
          <div className="ntl-co bl" /><div className="ntl-co br" />
          <div className="ntl-hdr">
            <div className="ntl-br2"><div className="ntl-dt" />NEXUS TRADING LABS</div>
            <button className="ntl-xb" onClick={handleClose}>✕</button>
          </div>
          <div className="ntl-pg">
            {STEPS.map((s, i) => (<div key={s.id} className={`ntl-pb ${i === step ? "a" : i < step ? "d" : ""}`} />))}
          </div>
          <div className="ntl-bd" key={step}>
            <div className="ntl-tg">{current.tag}</div>
            <div className="ntl-ic">{current.icon}</div>
            <div className="ntl-tl2">{current.title}</div>
            <div className="ntl-sb">{current.subtitle}</div>
            <div className="ntl-dc">{current.description}</div>
            {step === 1 && (
              <div className="ntl-chs">
                {CHAINS.map((c, i) => (<div key={c} className={`ntl-ch ${i === chainIdx ? "ac" : ""}`}>{c}</div>))}
              </div>
            )}
            <div className="ntl-ac">
              <button className="ntl-ct" onClick={handleNext}>
                {step === 1 ? "Show Me Where →" : step === STEPS.length - 1 ? "Launch App →" : `${current.cta} →`}
              </button>
              {step < STEPS.length - 1 && (<button className="ntl-sk" onClick={handleClose}>Skip</button>)}
            </div>
          </div>
          <div className="ntl-ft">
            <span className="ntl-fx">Powered by Orderly Network · Built on Arbitrum ·</span>
            <button className="ntl-fl">Disclaimer</button>
          </div>
        </div>
      </div>
    </>
  );
}