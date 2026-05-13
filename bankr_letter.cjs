const { Document, Packer, Paragraph, TextRun, BorderStyle } = require('docx');
const fs = require('fs');

const hrPara = new Paragraph({
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 6 } },
  spacing: { after: 240 },
  children: []
});

function heading(text) {
  return new Paragraph({
    spacing: { before: 320, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "EEEEEE", space: 4 } },
    children: [new TextRun({ text, bold: true, size: 26, font: "Arial" })]
  });
}

function body(text) {
  return new Paragraph({
    spacing: { after: 180 },
    children: [new TextRun({ text, size: 24, font: "Arial" })]
  });
}

function bullet(text) {
  return new Paragraph({
    spacing: { after: 100 },
    indent: { left: 360 },
    children: [new TextRun({ text: "• " + text, size: 24, font: "Arial" })]
  });
}

function label(text) {
  return new TextRun({ text, bold: true, size: 24, font: "Arial" });
}

const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: [
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "To: Bankr Partnership Team", size: 22, color: "666666", font: "Arial" })] }),
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "Re: Nexus Trading Labs × Bankr — Skill Integration Proposal", size: 22, color: "666666", font: "Arial" })] }),
      new Paragraph({ spacing: { after: 320 }, children: [new TextRun({ text: "From: Stephen, Founder — Nexus Trading Labs", size: 22, color: "666666", font: "Arial" })] }),
      hrPara,
      body("Nexus Trading Labs is proposing a formal skill integration with Bankr — giving Bankr agents access to 93+ perpetual markets (crypto, RWAs, equity indices) on Arbitrum, fully non-custodial, with on-chain trade verification and a live Rep Score leaderboard. The skill is built, deployed, and passing your team’s integration tests. This letter covers revenue structure, integration scope, and co-marketing terms."),
      heading("1 — What Bankr agents gain"),
      body("Nexus exposes the full Orderly Network liquidity stack through a single skill endpoint — no CLI, no credential management, no on-chain complexity. Agents can:"),
      bullet("Execute perps across 93+ markets (BTC, ETH, SOL, NVDA, TSLA, SPX, commodities) at up to 100x leverage"),
      bullet("Attach SL/TP, cancel orders, poll fill status — full order lifecycle management"),
      bullet("Deposit and withdraw USDC non-custodially via Bankr’s own wallet infrastructure"),
      bullet("Publish trading theses on-chain via ThesisRegistry (Arbitrum) — immutable, verifiable track record"),
      bullet("Query a trustless Rep Score leaderboard and copy top traders’ positions"),
      body("All of this is live today. Agents do not need a separate wallet, API key, or configuration beyond a one-time registration flow that the skill handles automatically."),
      heading("2 — Revenue model"),
      body("Nexus operates on Orderly’s broker ID system at public tier rates (3 bps crypto taker / 0 bps maker; 5 bps RWA taker / 0 bps maker). All volume routed through Bankr agents flows through our broker ID, generating fee revenue above Orderly’s base."),
      new Paragraph({
        spacing: { after: 180 },
        children: [
          new TextRun({ text: "Our preferred structure is a ", size: 24, font: "Arial" }),
          label("fee split on Bankr-routed volume"),
          new TextRun({ text: " — a percentage of taker fee revenue shared with Bankr on a per-trade basis. We’re open to a flat referral structure as an alternative. We’d welcome your team’s input on what structure works best for your existing integrations (Polymarket, Hyperliquid, Avantis) so we can align to a consistent model.", size: 24, font: "Arial" }),
        ]
      }),
      heading("3 — Traction"),
      body("Nexus is two months post-launch with ~$100k in early notional volume and ~10 active traders. Early numbers — but the infrastructure is the story: on-chain thesis registry, trustless leaderboard, and a fully functional Bankr skill that no other perp DEX has shipped. We’re optimizing for the right distribution channel, not vanity metrics. Bankr is that channel."),
      heading("4 — What we’re asking for"),
      new Paragraph({
        spacing: { after: 160 },
        children: [
          label("Featured skill placement "),
          new TextRun({ text: "in the Bankr catalog — the Nexus skill is production-complete and passing your integration review. We’d like to be listed alongside the other DeFi integrations your agents use.", size: 24, font: "Arial" }),
        ]
      }),
      new Paragraph({
        spacing: { after: 160 },
        children: [
          label("Positions tab integration "),
          new TextRun({ text: "— alongside Polymarket, Hyperliquid, and Avantis, so Bankr users can view and manage their Nexus perp positions natively in the terminal. Direct product improvement for your users, meaningful distribution for us.", size: 24, font: "Arial" }),
        ]
      }),
      body("We’d also propose a joint announcement: “first AI agent to trade perpetuals and publish verified on-chain theses” — a story neither of us can tell alone, and one that’s true and verifiable on Arbitrum right now."),
      heading("5 — Next steps"),
      body("Happy to get on a call to align on revenue terms, confirm the skill passes your final review, and coordinate the announcement. I’m also happy to share the full skill source and Worker code with your engineering team if that speeds up due diligence."),
      hrPara,
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "Stephen — Founder, Nexus Trading Labs", size: 22, font: "Arial", color: "555555" })] }),
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "@NexusTradingLab · nexustradinglabs.com · trade.nexustradinglabs.com", size: 22, font: "Arial", color: "555555" })] }),
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "[Email] · [Telegram / Discord]", size: 22, font: "Arial", color: "999999" })] }),
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('/sessions/nice-great-carson/mnt/nexus-4421/bankr-nexus-partnership-letter.docx', buf);
  console.log('done');
});
