import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import OnboardingModal from "@/components/OnboardingModal";
import { withBasePath } from "./utils/base-path";
import { getSEOConfig, getUserLanguage } from "./utils/seo";

const ORDERLY_MARKETS_KEY = "orderly_markets";
const NEXUS_FAVORITES_BACKUP = "nexus_favorites_backup";

function backupFavorites() {
  try {
    const raw = localStorage.getItem(ORDERLY_MARKETS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.favorites?.length > 0) {
      localStorage.setItem(NEXUS_FAVORITES_BACKUP, JSON.stringify(parsed.favorites));
    }
  } catch {}
}

function restoreFavorites() {
  try {
    const backup = localStorage.getItem(NEXUS_FAVORITES_BACKUP);
    if (!backup) return;
    const raw = localStorage.getItem(ORDERLY_MARKETS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed?.favorites?.length) {
      parsed.favorites = JSON.parse(backup);
      localStorage.setItem(ORDERLY_MARKETS_KEY, JSON.stringify(parsed));
    }
  } catch {}
}

export default function App() {
  const seoConfig = getSEOConfig();
  const defaultLanguage = getUserLanguage();
  const [showOnboarding, setShowOnboarding] = useState(
    !localStorage.getItem('ntl_onboarded')
  );

  useEffect(() => {
    const hasOnboarded = localStorage.getItem('ntl_onboarded');
    if (hasOnboarded === 'true') {
      setShowOnboarding(false);
    }

    // restore favorites on load
    restoreFavorites();

    // backup favorites whenever localStorage changes
    const handleStorage = () => backupFavorites();
    window.addEventListener("storage", handleStorage);

    // also poll every 3 seconds to catch same-tab changes
    const interval = setInterval(backupFavorites, 3000);

    return () => {
      window.removeEventListener("storage", handleStorage);
      clearInterval(interval);
    };
  }, []);
  
  return (
    <>
      <Helmet>
        <html lang={seoConfig.language || defaultLanguage} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/webp" href={withBasePath("/favicon.webp")} />
      </Helmet>
      <HttpsRequiredWarning />
      {showOnboarding && (
        <OnboardingModal
          onComplete={() => {
            localStorage.setItem('ntl_onboarded', 'true');
            setShowOnboarding(false);
          }}
          onSkip={() => setShowOnboarding(false)}
        />
      )}
      <OrderlyProvider>
        <Outlet />
      </OrderlyProvider>
    </>
  );
}
