import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { API } from "@orderly.network/types";
import { TradingPage } from "@orderly.network/trading";

// TradingFeatures enum isn't exported from the package, but disableFeatures takes its
// string values ("orderBook"). Type the literal via the prop's own type.
type DisableFeatures = React.ComponentProps<typeof TradingPage>["disableFeatures"];
import { updateSymbol } from "@/utils/storage";
import { formatSymbol, generatePageTitle } from "@/utils/utils";
import { useOrderlyConfig } from "@/utils/config";
import { getPageMeta } from "@/utils/seo";
import { renderSEOTags } from "@/utils/seo-tags";

export default function PerpSymbol() {
  const params = useParams();
  const [symbol, setSymbol] = useState(params.symbol!);
  const config = useOrderlyConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    updateSymbol(symbol);
  }, [symbol]);

  const onSymbolChange = useCallback(
    (data: API.Symbol) => {
      const symbol = data.symbol;
      setSymbol(symbol);

      const searchParamsString = searchParams.toString();
      const queryString = searchParamsString ? `?${searchParamsString}` : "";

      navigate(`/perp/${symbol}${queryString}`);
    },
    [navigate, searchParams]
  );

  // Collapse the order book to give the chart more room (desktop). Persisted.
  const [obCollapsed, setObCollapsed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("nexus_ob_collapsed") === "1"
  );
  const toggleOb = useCallback(() => {
    setObCollapsed((c) => {
      const next = !c;
      if (typeof window !== "undefined") window.localStorage.setItem("nexus_ob_collapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const pageMeta = getPageMeta();
  const pageTitle = generatePageTitle(formatSymbol(params.symbol!));

  return (
    <div className="h-full">
      {renderSEOTags(pageMeta, pageTitle)}
      {/* Desktop-only: collapse the order book → wider chart. */}
      <button
        onClick={toggleOb}
        title={obCollapsed ? "Show order book" : "Hide order book (wider chart)"}
        className="oui-hidden md:oui-flex"
        style={{
          position: "fixed", bottom: 16, right: 16, zIndex: 50,
          alignItems: "center", gap: 6, padding: "6px 12px",
          background: "#0a1a0a", color: "#00ff88", border: "1px solid #1a4a2a",
          borderRadius: 6, fontFamily: "monospace", fontSize: 11, fontWeight: "bold",
          cursor: "pointer", letterSpacing: "0.05em",
        }}
      >
        {obCollapsed ? "⊞ ORDER BOOK" : "⊟ ORDER BOOK"}
      </button>
      {/* key remounts TradingPage on toggle so disableFeatures reliably takes effect */}
      <TradingPage
        key={obCollapsed ? "tp-no-ob" : "tp-ob"}
        symbol={symbol}
        onSymbolChange={onSymbolChange}
        tradingViewConfig={config.tradingPage.tradingViewConfig}
        sharePnLConfig={config.tradingPage.sharePnLConfig}
        disableFeatures={obCollapsed ? (["orderBook"] as DisableFeatures) : undefined}
      />
      <div className="md:hidden pb-2 pt-8 text-center">
        <span className="oui-text-2xs oui-text-base-contrast-54">
          Charts powered by{" "}
          <a
            href="https://tradingview.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            TradingView
          </a>
        </span>
      </div>
    </div>
  );
}
