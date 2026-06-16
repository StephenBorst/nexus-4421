import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import OnboardingModal from "@/components/OnboardingModal";
import NexusAssistant from "@/components/NexusAssistant";
import LiveAlerts from "@/components/LiveAlerts";
import { withBasePath } from "./utils/base-path";
import { getSEOConfig, getUserLanguage } from "./utils/seo";
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
  }, []);
  
  return (
    <>
      <Helmet>
        <html lang={seoConfig.language || defaultLanguage} />
        <meta charSet="utf-8" />
        {/* Must keep viewport-fit=cover — Helmet was overriding index.html's and dropping it,
            so wallet in-app browsers reserved safe-area margins → app-wide dead space.
            Landing keeps cover and is clean; this restores parity. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
        <NexusAssistant />
        <LiveAlerts />
      </OrderlyProvider>
    </>
  );
}
