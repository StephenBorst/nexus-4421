import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import OnboardingModal from "@/components/OnboardingModal";
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
