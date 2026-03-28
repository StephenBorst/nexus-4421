import { Helmet } from "react-helmet-async";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { generatePageTitle } from "@/utils/utils";
import { Dashboard, ReferralProvider } from "@orderly.network/affiliate";
import { getRuntimeConfig } from "@/utils/runtime-config";
import { useAccount } from "@orderly.network/hooks";

export default function RewardsAffiliate() {
  const brokerName = getRuntimeConfig("VITE_ORDERLY_BROKER_NAME");
  const referralLinkUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://orderly.network";

  const [searchParams] = useSearchParams();
  const refCode = searchParams.get("ref");
  const { account } = useAccount();
  const bindAttempted = useRef(false);
  const [bindStatus, setBindStatus] = useState<"idle" | "success" | "error">("idle");
  const [bindMessage, setBindMessage] = useState<string>("");

  useEffect(() => {
    if (!refCode || !account?.accountId || bindAttempted.current) {
      return;
    }

    bindAttempted.current = true;

    const bindReferral = async () => {
      try {
        const response = await fetch("/api/referral/bind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referral_code: refCode,
            account_id: account.accountId,
          }),
        });

        const data = await response.json() as { success?: boolean; message?: string };

        if (response.ok && data.success) {
          setBindStatus("success");
          setBindMessage("Referral code applied successfully!");
        } else {
          setBindStatus("error");
          setBindMessage(data.message || "Failed to apply referral code.");
        }
      } catch {
        setBindStatus("error");
        setBindMessage("Failed to apply referral code.");
      }
    };

    bindReferral();
  }, [refCode, account?.accountId]);

  return (
    <>
      <Helmet>
        <title>{generatePageTitle("Affiliate")}</title>
      </Helmet>
      {bindStatus === "success" && (
        <div className="oui-bg-green-900/30 oui-border oui-border-green-600 oui-text-green-400 oui-text-sm oui-px-4 oui-py-2 oui-text-center">
          {bindMessage}
        </div>
      )}
      {bindStatus === "error" && (
        <div className="oui-bg-red-900/30 oui-border oui-border-red-600 oui-text-red-400 oui-text-sm oui-px-4 oui-py-2 oui-text-center">
          {bindMessage}
        </div>
      )}
      <ReferralProvider
        becomeAnAffiliateUrl="https://orderly.network"
        learnAffiliateUrl="https://orderly.network"
        referralLinkUrl={referralLinkUrl}
        overwrite={{
          shortBrokerName: brokerName,
          brokerName: brokerName,
        }}
      >
        <Dashboard.DashboardPage
          classNames={{
            root: "oui-flex oui-justify-center",
            home: "oui-py-6 oui-px-4 lg:oui-px-6 lg:oui-py-12 xl:oui-pl-4 xl:oui-pr-6 oui-w-full",
            dashboard: "oui-py-6 oui-px-4 lg:oui-px-6 xl:oui-pl-3 xl:oui-pr-6",
          }}
        />
      </ReferralProvider>
    </>
  );
}
